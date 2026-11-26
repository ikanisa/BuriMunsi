package rw.ikanisa.burimunsi.data

import android.content.Context
import app.cool.mobile.BuildConfig
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.storage.SecureStore
import rw.ikanisa.wire.BuriMunsiSchemas

/** Opaque, repository-owned read capability. No bearer or account material is
 * exposed to the screen/export layer; every page rechecks original ownership. */
class RecordReadScope internal constructor(private val owner:Any,private val verify:()->Unit,private val reader:(String)->String) {
    internal fun validate(expectedOwner:Any){checkContract(owner===expectedOwner,"session_changed");verify()}
    internal fun read(expectedOwner:Any,path:String):String {
        validate(expectedOwner);val result=reader(path);validate(expectedOwner);return result
    }
    override fun toString()="RecordReadScope"
}

internal data class RecordSnapshot<T>(val value:T,val offline:Boolean,val savedAt:Long?)

/** Serializes durable snapshot replacement with cache invalidation. A request
 * started before a committed mutation or sign-out cannot refill the cache. */
internal class NativeRecordCache(context:Context) {
    private companion object {
        val lock=ReentrantLock()
        val epoch=java.util.concurrent.atomic.AtomicLong()
        private class Pending(val revision: Long, val finished: CountDownLatch = CountDownLatch(1))
        private val pending = mutableMapOf<String, Pending>()
        // The durable cache contains at most eight entries. Keep the same bound on optional
        // queued writes and apply backpressure when a disk stays stalled.
        private val writer = ThreadPoolExecutor(1, 1, 10L, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(8),
            { work -> Thread(work, "burimunsi-record-cache").apply { isDaemon = true } },
            ThreadPoolExecutor.CallerRunsPolicy()).apply { allowCoreThreadTimeOut(true) }
    }
    private val file=SecureStore(context,"records")

    fun revision():Long=epoch.get()
    fun read(path:String):JSONObject? {
        // A subsequent read of this entry can immediately rely on a preceding live result,
        // including the first offline read after a successful response.
        val write = synchronized(pending) { pending[path]?.takeIf { it.revision == epoch.get() } }
        write?.finished?.await()
        return lock.withLock { currentCache() }
    }

    fun readRecent(path:String):JSONObject? {
        // An online shortcut can miss. Never put its live fallback behind
        // the encrypted writer for this page or a different screen.
        if(synchronized(pending){pending[path]?.revision==epoch.get()}||!lock.tryLock())return null
        return try{currentCache()}finally{lock.unlock()}
    }

    fun defer(path: String, revision: Long, persist: () -> Unit) {
        val write = Pending(revision)
        synchronized(pending) {
            if (revision != epoch.get()) return
            pending[path] = write
        }
        writer.execute {
            try { persist() }
            finally {
                synchronized(pending) { if (pending[path] === write) pending.remove(path) }
                write.finished.countDown()
            }
        }
    }

    fun update(revision:Long,replace:(JSONObject?)->JSONObject?):Unit=lock.withLock{
        if(revision==epoch.get())replace(currentCache())?.let{cache->
            val encoded=cache.put("appVersionCode",BuildConfig.VERSION_CODE).toString()
            if(encoded.toByteArray(Charsets.UTF_8).size<=1_000_000)file.write(encoded)
        }
    }

    // This file contains only disposable display snapshots. An APK update must
    // never restore an older build's records, and leaves all other stores alone.
    private fun currentCache():JSONObject? {
        val stored=file.read()?:return null
        val cache=try{JSONObject(stored)}catch(_:Exception){null}
        if(cache?.optInt("appVersionCode")==BuildConfig.VERSION_CODE)return cache
        file.clear()
        return null
    }

    fun clear(verify:Boolean=false):Unit=lock.withLock{
        epoch.incrementAndGet()
        file.clear()
        if(verify)checkContract(file.read()==null,"record_cache_unavailable")
    }
}

internal class NativeRecordData(
    private val sessions: NativeSessions,
    private val api: ApiClient,
    private val cacheStore: NativeRecordCache,
    private val receiptVersions: AllocationReceiptVersions,
    private val recordReadOwner: Any,
    private val deferDisplayCacheWrites: Boolean,
) : NativeSessionRequests by sessions {
    private data class CachedRecord(val payload:String,val savedAt:Long)

    private fun accessScope(owner:Operator)=owner.role.name+":"+owner.capabilities.sorted().joinToString(",")

    private fun cachedRecord(path:String,group:String,owner:Operator,sessionScope:String,now:Long,recent:Boolean):CachedRecord? {
        val cache=try{if(recent)cacheStore.readRecent(path)else cacheStore.read(path)}catch(_:Exception){null}?:return null
        if(cache.optString("contractVersion")!=BuriMunsiSchemas.VERSION||cache.optString("sessionScope")!=sessionScope||
            cache.optString("groupId")!=group||cache.optString("accountId")!=owner.id||
            cache.optString("accessScope")!=accessScope(owner))return null
        val entry=cache.optJSONObject("entries")?.optJSONObject(path)?:return null
        val stored=entry.opt("savedAt")
        if(stored !is Long&&stored !is Int)return null
        val saved=(stored as Number).toLong()
        val current=if(recent)SnapshotFreshness.recent(saved,now)else SnapshotFreshness.reusable(saved,now)
        return if(current)CachedRecord(entry.optString("payload"),saved)else null
    }

    private fun <T> recentRecord(path:String,decode:(String)->T):Pair<T,Long>? {
        val witness=ownedSession()
        val (owner,group)=authority.withCurrent(witness){(operator?:throw ApiFailure("session_unavailable",401)) to groupId}
        val now=System.currentTimeMillis()
        checkContract(now<owner.expiresAt,"session_unavailable")
        val revision=cacheStore.revision()
        // Encrypted storage and validation can wait on IO without holding the
        // process authority needed by foreground navigation and sign-out.
        val entry=cachedRecord(path,group,owner,Values.sha256(witness.token),now,recent=true) ?: return null
        val record=try {
            decode(api.validateCached(path,entry.payload,
                mapOf("groupId" to group,"actorId" to owner.id,"generation" to witness.generation.toString())))
        }catch(_:Exception){return null}
        return authority.withCurrent(witness){
            val finished=System.currentTimeMillis()
            checkContract(operator===owner&&groupId==group,"session_changed")
            checkContract(finished<owner.expiresAt,"session_unavailable")
            if(cacheStore.revision()==revision&&SnapshotFreshness.recent(entry.savedAt,finished))record to entry.savedAt else null
        }
    }

    fun recentPayments(listing:ListingQuery)=recentRecord(listingPath("/payments",ListingTarget.PAYMENTS,listing,null)){ value->
        val payments=page(value,::decodePayment)
        payments.copy(items=payments.items.map{it.copy(sourceId=null)})
    }

    fun recentMembers(listing:ListingQuery)=recentRecord(listingPath("/members",ListingTarget.MEMBERS,listing,null)){
        page(it,::decodeMember)
    }

    private fun records(path:String):String = records(path){value,_->value}
    private fun <T> records(path:String,read:(String,Operator)->T):T = snapshot(path,read=read).value

    private fun <T> snapshot(path:String,firstDisplay:Boolean=false,
        fetch:(SessionWitness)->String={witness->requestOwned(witness,"GET",path)},
        read:(String,Operator)->T,
    ):RecordSnapshot<T> {
        val witness=ownedSession()
        val (who,group)=authority.withCurrent(witness){(operator?:throw ApiFailure("session_unavailable",401)) to groupId}
        if(System.currentTimeMillis()>=who.expiresAt)throw ApiFailure("session_unavailable",401)
        val sessionScope=Values.sha256(witness.token)
        val revision=cacheStore.revision()
        try {
            val value=fetch(witness)
            val verified=authority.withCurrent(witness){
                val now=System.currentTimeMillis()
                checkContract(now<who.expiresAt,"session_unavailable")
                val result=read(value,who)
                sessions.markRead(now, fromCache = false)
                result to now
            }
            persistRecord(path,value,who,group,sessionScope,verified.second,revision,firstDisplay)
            return authority.withCurrent(witness){RecordSnapshot(verified.first,false,verified.second)}
        }catch(error:ApiFailure){
            if(error.status!=0||error.code!="connection_unavailable")throw error
            return authority.withCurrent(witness){
                val now=System.currentTimeMillis()
                if(now>=who.expiresAt)throw ApiFailure("session_unavailable",401)
                val entry=cachedRecord(path,groupId,who,sessionScope,now,recent=false)?:throw error
                val payload=api.validateCached(path,entry.payload,mapOf("groupId" to groupId,"actorId" to who.id,"generation" to witness.generation.toString()))
                val result=read(payload,who)
                sessions.markRead(entry.savedAt, fromCache = true)
                RecordSnapshot(result,true,entry.savedAt)
            }
        }
    }
    private fun persistRecord(path:String,payload:String,owner:Operator,group:String,sessionScope:String,now:Long,
        revision:Long,firstDisplay:Boolean) {
        if (deferDisplayCacheWrites && firstDisplay) {
            cacheStore.defer(path,revision) { saveRecord(path,payload,owner,group,sessionScope,now,revision) }
        } else saveRecord(path,payload,owner,group,sessionScope,now,revision)
    }

    private fun saveRecord(path:String,payload:String,owner:Operator,group:String,sessionScope:String,now:Long,revision:Long) {
        try {
            cacheStore.update(revision){stored->
                var cache=stored
                val access=accessScope(owner)
                if(cache?.optString("sessionScope")!=sessionScope||cache.optString("contractVersion")!=BuriMunsiSchemas.VERSION||
                    cache.optString("groupId")!=group||cache.optString("accountId")!=owner.id||
                    cache.optString("accessScope")!=access)cache=null
                val entries=cache?.optJSONObject("entries")?:JSONObject()
                // An earlier in-flight read can reach the write lock second.
                if((entries.optJSONObject(path)?.opt("savedAt") as? Number)?.toLong()?.let{it>now}==true)return@update null
                entries.put(path,JSONObject().put("savedAt",now).put("payload",payload))
                while(entries.length()>8){val key=entries.keys().asSequence().minByOrNull{entries.getJSONObject(it).getLong("savedAt")}?:break;entries.remove(key)}
                JSONObject().put("contractVersion",BuriMunsiSchemas.VERSION).put("groupId",group).put("accountId",owner.id)
                    .put("sessionScope",sessionScope).put("accessScope",access).put("entries",entries)
            }
        }catch(_:Exception){/* Cache persistence cannot change the canonical response. */}
    }

    fun acceptRestoredHome(owner:Operator,payload:JSONObject,revision:Long):Pair<Home,Long>? {
        val witness=ownedSession()
        if(cacheStore.revision()!=revision)return null
        val (home,now,group)=authority.withCurrent(witness) {
            checkContract(operator===owner,"session_changed")
            val now=System.currentTimeMillis()
            checkContract(now<owner.expiresAt,"session_unavailable")
            val home=decodeHome(payload)
            sessions.markRead(now,fromCache=false)
            Triple(home,now,groupId)
        }
        persistRecord("/home",payload.toString(),owner,group,Values.sha256(witness.token),now,revision,firstDisplay=true)
        return authority.withCurrent(witness){
            checkContract(operator===owner,"session_changed")
            (home to now).takeIf{cacheStore.revision()==revision}
        }
    }

    fun home():RecordSnapshot<Home> = snapshot("/home",firstDisplay=true,fetch={sessions.requestHome(it)}){value,_->decodeHome(JSONObject(value))}

    fun readQuietHome(): JSONObject {
        val scope = recordReadScope { witness, _ -> sessions.requestHome(witness) }
        return JSONObject(scope.read(recordReadOwner, "/home"))
    }
    fun readHomeEnhancement(owner: Operator): Home? {
        val scope = recordReadScope(expectedOwner=owner) { witness, _ -> sessions.requestHome(witness, allowLegacy = false) }
        return try {
            decodeHome(JSONObject(scope.read(recordReadOwner, HOME_SAVINGS_PATH))).also {
                checkContract(it.savings != null,"invalid_api_response")
            }
        } catch (error: ApiFailure) {
            if (!error.isLegacyHomeSelectorRejection()) throw error
            null
        }
    }

    private fun decodeHome(j:JSONObject):Home{
        val a=j.getJSONArray("recentPayments")
        val paymentCount = if (j.has("paymentCount") && !j.isNull("paymentCount")) j.counter("paymentCount", Int.MAX_VALUE.toLong()).toInt() else null
        val unallocated = j.counter("unallocatedCount", Int.MAX_VALUE.toLong()).toInt()
        checkContract(paymentCount == null || (unallocated <= paymentCount && a.length() <= paymentCount), "invalid_api_response")
        return Home(
            paymentCount = paymentCount,
            memberCount = j.counter("memberCount", Int.MAX_VALUE.toLong()).toInt(),
            unallocatedCount = unallocated,
            recent = (0 until a.length()).map { decodePayment(a.getJSONObject(it)) },
            asOf = j.getString("asOf"),
            savings = if (j.has("savings")) decodeHomeSavings(j.getJSONObject("savings")) else null,
        )
    }
    private fun decodeHomeSavings(j: JSONObject): HomeSavings {
        val status = j.get("reconciliationStatus")
        checkContract(status is String && status in setOf("reconciled","mismatch","unavailable"),"invalid_api_response")
        fun amount(name: String): Long? {
            checkContract(j.has(name),"invalid_api_response")
            return if (j.isNull(name)) null else j.counter(name,9_007_199_254_740_991L)
        }
        return HomeSavings(amount("lifetimeContributionsRwf"),amount("outgoingPaymentsRwf"),
            amount("latestWalletBalanceRwf"),status as String)
    }
    /** Full-query export collectors use online reads with one immutable local
     * identity witness. Server cursors independently bind group/actor/query and
     * data revision. Ordinary offline cache is deliberately unavailable here. */
    fun recordReadScope():RecordReadScope =
        recordReadScope { witness, path -> requestOwned(witness, "GET", path) }

    private fun recordReadScope(expectedOwner: Operator?=null, read: (SessionWitness, String) -> String):RecordReadScope {
        val witness=ownedSession()
        val captured=authority.withCurrent(witness){
            val who=operator?:throw ApiFailure("session_unavailable",401)
            checkContract(expectedOwner==null || who===expectedOwner && Capability.READ.key in who.capabilities,"session_changed")
            checkContract(System.currentTimeMillis()<who.expiresAt&&!sessions.hasInflightPasscode(witness),"session_unavailable")
            Triple(groupId,who.id,who.role to who.capabilities.toSet())
        }
        val verify={authority.withCurrent(witness){
            val who=operator?:throw ApiFailure("session_unavailable",401)
            checkContract((expectedOwner==null || who===expectedOwner) && groupId==captured.first&&who.id==captured.second&&who.role==captured.third.first&&
                who.capabilities==captured.third.second&&System.currentTimeMillis()<who.expiresAt&&!sessions.hasInflightPasscode(witness),"session_changed")
        }}
        return RecordReadScope(recordReadOwner,verify){path->verify();read(witness,path)}
    }
    fun validateRecordReadScope(scope:RecordReadScope){scope.validate(recordReadOwner)}
    private fun listingRead(path:String,scope:RecordReadScope?):String =
        scope?.read(recordReadOwner,path)?:sessions.request("GET",path)
    fun payments(listing:ListingQuery,cursor:String?=null,memberId:String?=null,scope:RecordReadScope?=null):Page<Payment> {
        if(scope==null)return paymentPage(listing,cursor,memberId).value
        val member=memberId?.let(Values::id)
        val path=listingPath("/payments",ListingTarget.PAYMENTS,listing,cursor,mapOf("memberId" to member))
        return decodePaymentPage(scope.read(recordReadOwner,path),member)
    }
    fun paymentPage(listing:ListingQuery,cursor:String?=null,memberId:String?=null):RecordSnapshot<Page<Payment>> {
        val member=memberId?.let(Values::id)
        val path=listingPath("/payments",ListingTarget.PAYMENTS,listing,cursor,mapOf("memberId" to member))
        return snapshot(path,firstDisplay=cursor==null){payload,_->decodePaymentPage(payload,member)}
    }
    private fun decodePaymentPage(payload:String,member:String?):Page<Payment> {
        val result=page(payload,::decodePayment)
        if(member!=null)checkContract(result.items.all{it.memberId==member},"invalid_member_payment_scope")
        return result
    }
    fun members(listing: ListingQuery, cursor: String? = null, scope: RecordReadScope? = null, anchorId: String? = null): Page<Member> {
        if(scope==null)return memberPage(listing,cursor,anchorId).value
        return page(scope.read(recordReadOwner,membersPath(listing,cursor,anchorId)),::decodeMember)
    }
    fun memberPage(listing: ListingQuery, cursor: String? = null, anchorId: String? = null): RecordSnapshot<Page<Member>> =
        snapshot(membersPath(listing,cursor,anchorId),firstDisplay=cursor==null){payload,_->page(payload,::decodeMember)}

    private fun membersPath(listing: ListingQuery,cursor: String?,anchorId: String?):String {
        checkContract(anchorId == null || cursor == null, "invalid_query")
        return listingPath("/members", ListingTarget.MEMBERS, listing, cursor,
            mapOf("anchorId" to anchorId?.let(Values::id)))
    }
    fun sms(listing:ListingQuery,cursor:String?=null,scope:RecordReadScope?=null,limit:Int=100):Page<SmsRow> =
        page(listingRead(listingPath("/sms",ListingTarget.SMS,listing,cursor,limit=limit),scope),::decodeSms)
    fun staff(listing:ListingQuery,cursor:String?=null,scope:RecordReadScope?=null):Page<StaffAccount> =
        page(listingRead(listingPath("/staff",ListingTarget.STAFF,listing,cursor),scope),::decodeStaff)
    fun audit(listing:ListingQuery,cursor:String?=null,scope:RecordReadScope?=null):Page<AuditRow> =
        page(listingRead(listingPath("/audit",ListingTarget.AUDIT,listing,cursor),scope)){j->AuditRow(j.getString("id"),j.getString("action"),j.getString("at"))}
    fun payments(q:String="",filter:String="all",cursor:String?=null,memberId:String?=null):Page<Payment>{
        val member=memberId?.let(Values::id)
        val result=page(records("/payments"+query(mapOf("q" to q,"filter" to filter,"cursor" to cursor,"memberId" to member))),::decodePayment)
        if(member!=null)checkContract(result.items.all{it.memberId==member},"invalid_member_payment_scope")
        return result
    }
    fun members(q:String="",cursor:String?=null)=page(records("/members"+query(mapOf("q" to q,"cursor" to cursor))),::decodeMember)
    fun payment(id:String):Payment = paymentRecord(id).value

    fun paymentRecord(id:String):RecordSnapshot<Payment> {
        val paymentId=Values.id(id)
        return snapshot("/payments/$paymentId",firstDisplay=true){payload,owner->
            val payment=decodePaymentDetail(JSONObject(payload))
            if(payment.id!=paymentId)throw ApiFailure("record_unavailable")
            receiptVersions.requireNewer(owner.id,groupId,paymentId,payment.version)
            payment
        }
    }
    fun member(id:String):Member = memberRecord(id).value

    fun memberRecord(id:String):RecordSnapshot<Member> {
        val memberId=Values.id(id)
        return snapshot("/members/$memberId",firstDisplay=true){payload,_->
            val member=decodeMember(JSONObject(payload))
            checkContract(member.id==memberId,"invalid_api_response")
            member
        }
    }
    fun sms(q:String="",cursor:String?=null,filter:String="all",limit:Int?=null)=page(sessions.request("GET","/sms"+query(mapOf("q" to q,"cursor" to cursor,"filter" to filter,"limit" to limit?.coerceIn(1,100)?.toString()))),::decodeSms)
    fun staff(cursor:String?=null)=page(sessions.request("GET","/staff"+query(mapOf("cursor" to cursor))),::decodeStaff)
    fun audit(cursor:String?=null)=page(sessions.request("GET","/audit"+query(mapOf("cursor" to cursor)))){j->AuditRow(j.getString("id"),j.getString("action"),j.getString("at"))}
}
