package rw.ikanisa.burimunsi.data

import android.content.Context
import org.json.JSONObject
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
        val lock=Any()
        val epoch=java.util.concurrent.atomic.AtomicLong()
    }
    private val file=SecureStore(context,"records")

    fun revision():Long=epoch.get()
    fun read():String?=file.read()

    fun update(revision:Long,replace:(String?)->String?):Unit=synchronized(lock){
        if(revision==epoch.get())replace(file.read())?.let(file::write)
    }

    fun clear(verify:Boolean=false):Unit=synchronized(lock){
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
) : NativeSessionRequests by sessions {
    private data class CachedRecord(val payload:String,val savedAt:Long)

    private fun accessScope(owner:Operator)=owner.role.name+":"+owner.capabilities.sorted().joinToString(",")

    private fun cachedRecord(path:String,group:String,owner:Operator,sessionScope:String,now:Long,recent:Boolean):CachedRecord? {
        val cache=try{cacheStore.read()?.let(::JSONObject)}catch(_:Exception){null}?:return null
        if(cache.optString("contractVersion")!=BuriMunsiSchemas.VERSION||cache.optString("sessionScope")!=sessionScope||
            cache.optString("groupId")!=group||cache.optString("accountId")!=owner.id)return null
        if((recent||cache.has("accessScope"))&&cache.optString("accessScope")!=accessScope(owner))return null
        val entry=cache.optJSONObject("entries")?.optJSONObject(path)?:return null
        val stored=entry.opt("savedAt")
        if(stored !is Long&&stored !is Int)return null
        val saved=(stored as Number).toLong()
        val current=if(recent)SnapshotFreshness.recent(saved,now)else SnapshotFreshness.reusable(saved,now)
        return if(current)CachedRecord(entry.optString("payload"),saved)else null
    }

    fun hasRecentHome(saved:SavedNativeSession):Boolean {
        val owner=saved.operatorOrNull()?:return false
        val now=System.currentTimeMillis()
        if(now>=owner.expiresAt)return false
        val entry=cachedRecord("/home",saved.groupId,owner,Values.sha256(saved.token),now,recent=true)?:return false
        // Upgrade a fresh legacy Home through the bundled read when we can reach the server.
        return runCatching { JSONObject(entry.payload).getJSONObject("savings") }.isSuccess
    }

    private fun <T> recentRecord(path:String,expectedOwner:Operator?=null,decode:(String)->T):Pair<T,Long>? {
        val witness=ownedSession()
        return authority.withCurrent(witness){
            val owner=operator?:throw ApiFailure("session_unavailable",401)
            checkContract(expectedOwner==null||owner===expectedOwner,"session_changed")
            val now=System.currentTimeMillis()
            checkContract(now<owner.expiresAt,"session_unavailable")
            val entry=cachedRecord(path,groupId,owner,Values.sha256(witness.token),now,recent=true)
                ?:return@withCurrent null
            // Confirmed session, original snapshot time. Never use cached
            // bytes from a prior capability set or refresh their age locally.
            val record=try {
                decode(api.validateCached(path,entry.payload,
                    mapOf("groupId" to groupId,"actorId" to owner.id,"generation" to witness.generation.toString())))
            }catch(_:Exception){return@withCurrent null}
            record to entry.savedAt
        }
    }

    // Preserve financial rows while requiring a live receipt read for its SMS source.
    fun recentHome(owner:Operator)=recentRecord("/home",owner){ value->
        val home=decodeHome(JSONObject(value))
        home.copy(recent=home.recent.map{it.copy(sourceId=null)})
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

    private fun <T> snapshot(path:String,fetch:(SessionWitness)->String={requestOwned(it,"GET",path)},read:(String,Operator)->T):RecordSnapshot<T> {
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
            saveRecord(path,value,who,group,sessionScope,verified.second,revision)
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
    private fun saveRecord(path:String,payload:String,owner:Operator,group:String,sessionScope:String,now:Long,revision:Long) {
        try {
            cacheStore.update(revision){stored->
                var cache=stored?.let(::JSONObject)
                val access=accessScope(owner)
                if(cache?.optString("sessionScope")!=sessionScope||cache.optString("contractVersion")!=BuriMunsiSchemas.VERSION||
                    cache.optString("groupId")!=group||cache.optString("accountId")!=owner.id||
                    cache.optString("accessScope")!=access)cache=null
                val entries=cache?.optJSONObject("entries")?:JSONObject()
                // An earlier in-flight read can reach the write lock second.
                if((entries.optJSONObject(path)?.opt("savedAt") as? Number)?.toLong()?.let{it>now}==true)return@update null
                entries.put(path,JSONObject().put("savedAt",now).put("payload",payload))
                while(entries.length()>8){val key=entries.keys().asSequence().minByOrNull{entries.getJSONObject(it).getLong("savedAt")}?:break;entries.remove(key)}
                val saved=JSONObject().put("contractVersion",BuriMunsiSchemas.VERSION).put("groupId",group).put("accountId",owner.id)
                    .put("sessionScope",sessionScope).put("accessScope",access).put("entries",entries).toString()
                saved.takeIf{it.toByteArray(Charsets.UTF_8).size<=1_000_000}
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
        saveRecord("/home",payload.toString(),owner,group,Values.sha256(witness.token),now,revision)
        return authority.withCurrent(witness){
            checkContract(operator===owner,"session_changed")
            (home to now).takeIf{cacheStore.revision()==revision}
        }
    }

    fun home():Home=snapshot("/home",fetch={sessions.readSavingsHome(it,publishProvenance=true)}) { value,_->decodeHome(JSONObject(value)) }.value

    fun readQuietHome(): JSONObject {
        val scope = recordReadScope { witness, _ -> sessions.readSavingsHome(witness,publishProvenance=false) }
        return JSONObject(scope.read(recordReadOwner, "/home"))
    }
    private fun decodeHome(j:JSONObject):Home{
        val a=j.getJSONArray("recentPayments")
        return Home(j.amount("groupBalanceRwf"),j.amount("todayRwf"),j.getInt("memberCount"),j.getInt("unallocatedCount"),(0 until a.length()).map{decodePayment(a.getJSONObject(it))},j.getString("asOf"),if(j.has("unallocatedAmountRwf")&&!j.isNull("unallocatedAmountRwf"))j.amount("unallocatedAmountRwf")else null,
            if(j.has("savings"))decodeHomeSavings(j.getJSONObject("savings"))else null)
    }
    /** Full-query export collectors use online reads with one immutable local
     * identity witness. Server cursors independently bind group/actor/query and
     * data revision. Ordinary offline cache is deliberately unavailable here. */
    fun recordReadScope():RecordReadScope =
        recordReadScope { witness, path -> requestOwned(witness, "GET", path) }

    private fun recordReadScope(read: (SessionWitness, String) -> String):RecordReadScope {
        val witness=ownedSession()
        val captured=authority.withCurrent(witness){
            val who=operator?:throw ApiFailure("session_unavailable",401)
            checkContract(System.currentTimeMillis()<who.expiresAt&&!sessions.hasInflightPasscode(witness),"session_unavailable")
            Triple(groupId,who.id,who.role to who.capabilities.toSet())
        }
        val verify={authority.withCurrent(witness){
            val who=operator?:throw ApiFailure("session_unavailable",401)
            checkContract(groupId==captured.first&&who.id==captured.second&&who.role==captured.third.first&&
                who.capabilities==captured.third.second&&System.currentTimeMillis()<who.expiresAt&&!sessions.hasInflightPasscode(witness),"session_changed")
        }}
        return RecordReadScope(recordReadOwner,verify){path->verify();read(witness,path)}
    }
    fun validateRecordReadScope(scope:RecordReadScope){scope.validate(recordReadOwner)}
    private fun listingRead(target:ListingTarget,path:String,scope:RecordReadScope?):String {
        return scope?.read(recordReadOwner,path)?:if(target in setOf(ListingTarget.PAYMENTS,ListingTarget.MEMBERS,ListingTarget.LEDGER,ListingTarget.HISTORY))records(path)else sessions.request("GET",path)
    }
    fun payments(listing:ListingQuery,cursor:String?=null,memberId:String?=null,scope:RecordReadScope?=null):Page<Payment> {
        if(scope==null)return paymentPage(listing,cursor,memberId).value
        val member=memberId?.let(Values::id)
        val path=listingPath("/payments",ListingTarget.PAYMENTS,listing,cursor,mapOf("memberId" to member))
        return decodePaymentPage(scope.read(recordReadOwner,path),member)
    }
    fun paymentPage(listing:ListingQuery,cursor:String?=null,memberId:String?=null):RecordSnapshot<Page<Payment>> {
        val member=memberId?.let(Values::id)
        val path=listingPath("/payments",ListingTarget.PAYMENTS,listing,cursor,mapOf("memberId" to member))
        return snapshot(path){payload,_->decodePaymentPage(payload,member)}
    }
    private fun decodePaymentPage(payload:String,member:String?):Page<Payment> {
        val result=page(payload,::decodePayment)
        if(member!=null)checkContract(result.items.all{it.memberId==member},"invalid_member_payment_scope")
        return result
    }
    fun members(listing: ListingQuery, cursor: String? = null, scope: RecordReadScope? = null, anchorId: String? = null): Page<Member> {
        checkContract(anchorId == null || cursor == null, "invalid_query")
        val path = listingPath("/members", ListingTarget.MEMBERS, listing, cursor,
            mapOf("anchorId" to anchorId?.let(Values::id)))
        return page(listingRead(ListingTarget.MEMBERS, path, scope), ::decodeMember)
    }
    fun ledger(id:String,listing:ListingQuery,cursor:String?=null,scope:RecordReadScope?=null):Page<LedgerRow> =
        page(listingRead(ListingTarget.LEDGER,listingPath("/ledger",ListingTarget.LEDGER,listing,cursor,mapOf("memberId" to Values.id(id))),scope),::decodeLedger)
    fun sms(listing:ListingQuery,cursor:String?=null,scope:RecordReadScope?=null,limit:Int=100):Page<SmsRow> =
        page(listingRead(ListingTarget.SMS,listingPath("/sms",ListingTarget.SMS,listing,cursor,limit=limit),scope),::decodeSms)
    fun staff(listing:ListingQuery,cursor:String?=null,scope:RecordReadScope?=null):Page<StaffAccount> =
        page(listingRead(ListingTarget.STAFF,listingPath("/staff",ListingTarget.STAFF,listing,cursor),scope),::decodeStaff)
    fun audit(listing:ListingQuery,cursor:String?=null,scope:RecordReadScope?=null):Page<AuditRow> =
        page(listingRead(ListingTarget.AUDIT,listingPath("/audit",ListingTarget.AUDIT,listing,cursor),scope)){j->AuditRow(j.getString("id"),j.getString("action"),j.getString("at"))}
    fun paymentHistory(id:String,listing:ListingQuery,cursor:String?=null,scope:RecordReadScope?=null):Page<PaymentEvent> {
        val transactionId=Values.id(id)
        return decodePaymentHistory(listingRead(ListingTarget.HISTORY,listingPath("/payments/$transactionId/history",ListingTarget.HISTORY,listing,cursor),scope),groupId,transactionId)
    }
    fun payments(q:String="",filter:String="all",cursor:String?=null,memberId:String?=null):Page<Payment>{
        val member=memberId?.let(Values::id)
        val result=page(records("/payments"+query(mapOf("q" to q,"filter" to filter,"cursor" to cursor,"memberId" to member))),::decodePayment)
        if(member!=null)checkContract(result.items.all{it.memberId==member},"invalid_member_payment_scope")
        return result
    }
    fun members(q:String="",cursor:String?=null)=page(records("/members"+query(mapOf("q" to q,"cursor" to cursor))),::decodeMember)
    fun payment(id:String):Payment {
        val paymentId=Values.id(id)
        return records("/payments/$paymentId"){payload,owner->
            val payment=decodePaymentDetail(JSONObject(payload))
            if(payment.id!=paymentId)throw ApiFailure("record_unavailable")
            receiptVersions.requireNewer(owner.id,groupId,paymentId,payment.version)
            payment
        }
    }
    fun member(id:String):Member = memberRecord(id).value

    fun memberRecord(id:String):RecordSnapshot<Member> {
        val memberId=Values.id(id)
        return snapshot("/members/$memberId"){payload,_->
            val member=decodeMember(JSONObject(payload))
            checkContract(member.id==memberId,"invalid_api_response")
            member
        }
    }
    fun ledger(id:String,cursor:String?=null)=page(records("/ledger"+query(mapOf("memberId" to Values.id(id),"cursor" to cursor))),::decodeLedger)
    fun sms(q:String="",cursor:String?=null,filter:String="all",limit:Int?=null)=page(sessions.request("GET","/sms"+query(mapOf("q" to q,"cursor" to cursor,"filter" to filter,"limit" to limit?.coerceIn(1,100)?.toString()))),::decodeSms)
    fun staff(cursor:String?=null)=page(sessions.request("GET","/staff"+query(mapOf("cursor" to cursor))),::decodeStaff)
    fun audit(cursor:String?=null)=page(sessions.request("GET","/audit"+query(mapOf("cursor" to cursor)))){j->AuditRow(j.getString("id"),j.getString("action"),j.getString("at"))}
    fun paymentHistory(id:String,cursor:String?=null):Page<PaymentEvent> {
        val transactionId=Values.id(id)
        return decodePaymentHistory(records("/payments/$transactionId/history"+query(mapOf("cursor" to cursor))),groupId,transactionId)
    }
}
