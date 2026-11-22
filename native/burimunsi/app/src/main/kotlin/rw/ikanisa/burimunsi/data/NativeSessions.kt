package rw.ikanisa.burimunsi.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.storage.SecureStore
import java.security.SecureRandom
import java.util.UUID

/** Native login, protected credentials and lifecycle of the process-wide session. */
internal class NativeSessions(
    context: Context,
    private val api: ApiClient,
    groupId: String?,
    private val cacheStore: NativeRecordCache,
) : NativeSessionRequests {
    companion object {
        private val signOutLock = Any()
        // UI and the foreground supervisor share one ordered server-profile
        // stream. This lock never excludes logout or credential replacement.
        private val sessionRefreshLock=Any()
        private val processSessionAuthority=SessionAuthority()
        private var signOutRetryRunning=false

        private fun pendingSignOut(saved:SavedNativeSession,raw:String?):Boolean {
            if(raw==null)return false
            val entries=JSONObject(raw).getJSONArray("entries");checkContract(entries.length()<=50,"operation_store_unavailable")
            val proofs=listOfNotNull(saved.token,saved.pendingPasscode?.token)
            return (0 until entries.length()).any{i->val entry=entries.getJSONObject(i)
                entry.getString("groupId")==saved.groupId&&proofs.any{proof->
                    proof==entry.getString("token")||entry.optString("candidate")==proof}}
        }

        /** Caller holds processSessionAuthority. Expired metadata may authorize
         * a visible renewal attempt, never observation capture or upload. */
        private fun observationIdentifiers(context:Context,allowExpired:Boolean):Pair<String,String>? {
            if(SecureStore(context,"signed-out").read()!=null||!processSessionAuthority.observationAdmitted())return null
            val saved=SavedNativeSession.decode(SecureStore(context,"session").read()?:return null)
            if(!allowExpired&&saved.expiresAt<=System.currentTimeMillis())return null
            if(processSessionAuthority.hasActive()){
                if(processSessionAuthority.capture().token!=saved.token)return null
            }else if(processSessionAuthority.revision()!=0L)return null
            if(saved.pendingPasscode?.stage==PasscodeStage.INFLIGHT)return null
            if(synchronized(signOutLock){pendingSignOut(saved,SecureStore(context,"session-revocations").read())})return null
            val profile=saved.operatorOrNull()?:return null
            if(profile.role!=Role.ADMIN||!profile.capabilities.containsAll(setOf(Capability.SMS.key,Capability.GATEWAY.key)))return null
            return saved.groupId to profile.id
        }

        /** Foreground-supervisor eligibility only. The supervisor must still
         * call restore() before any scan/upload; an expired lease grants none. */
        internal fun canRestoreObservationOwner(context:Context):Boolean=restorableObservationOwner(context)!=null
        /** Identifiers for persisted pause/control lookup during renewal only;
         * this never returns an ObservationSessionOwner or a capture witness. */
        internal fun restorableObservationOwner(context:Context):ObservationOwner?=synchronized(processSessionAuthority){
            try{observationIdentifiers(context,allowExpired=true)?.let{ObservationOwner(it.first,it.second)}}catch(_:Exception){null}
        }

        /** Serialize local observation custody with login/logout on the same process.
         * The callback receives only validated scope identifiers, never a bearer. */
        internal fun observationOwner(context:Context):ObservationSessionOwner? =
            withObservationOwner(context){group,account->ObservationSessionOwner(ObservationOwner(group,account),processSessionAuthority.revision())}
        internal fun <T> withObservationOwner(context:Context,expected:ObservationSessionOwner?=null,action:(String,String)->T):T? = synchronized(processSessionAuthority){
            val identifiers=try{observationIdentifiers(context,allowExpired=false)}catch(_:Exception){null}?:return@synchronized null
            if(expected!=null&&expected!=ObservationSessionOwner(ObservationOwner(identifiers.first,identifiers.second),processSessionAuthority.revision()))return@synchronized null
            action(identifiers.first,identifiers.second)
        }
    }
    @Volatile private var boundGroup:String?=groupId?.let(Values::id)
    private val configuredGroup=groupId?.let(Values::id)
    override val groupId: String get() = boundGroup ?: throw ApiFailure("session_unavailable", 401)
    val boundCollectionId:String? get()=boundGroup
    private val sessionStore=SecureStore(context,"session")
    private val revocationStore=SecureStore(context,"session-revocations")
    private val signedOutStore=SecureStore(context,"signed-out")
    override val authority = processSessionAuthority
    private data class LocalOwnership(val group:String,val owner:String?,val tokenHash:String)
    @Volatile private var ownedWitness:SessionWitness?=null
    val sessionRevision:Long? get()=ownedWitness?.generation
    @Volatile private var lastOwned:LocalOwnership?=null
    @Volatile override var operator: Operator? = null
        private set
    var lastReadSavedAt:Long?=null;private set
    var lastReadFromCache=false;private set

    fun markRead(savedAt: Long, fromCache: Boolean) {
        lastReadFromCache = fromCache
        lastReadSavedAt = savedAt
    }

    private fun clearMemoryOperator(){ownedWitness=null;operator=null;lastReadFromCache=false;lastReadSavedAt=null}
    override fun ownedSession():SessionWitness {
        val witness=ownedWitness?:throw ContractFailure("session_unavailable")
        return authority.withCurrent(witness){witness}
    }
    private fun clearLocalOperator(){
        clearMemoryOperator()
        sessionStore.clear()
        check(sessionStore.read()==null){"Protected session could not be removed"}
        cacheStore.clear();lastOwned=null
    }
    private fun confirmedSessionDenial(e:ApiFailure):Boolean=!e.uncertain&&when(e.status){
        401->e.code in setOf("session_unavailable","invalid_credentials","invalid_session")
        403->e.code in setOf("native_scope_changed","access_denied","permission_denied")
        else->false
    }

    private fun readSavedSession():SavedNativeSession? =
        sessionStore.read()?.let(SavedNativeSession::decode)

    private fun clearMemoryFor(witness:SessionWitness) = synchronized(authority){
        if(ownedWitness==witness)clearMemoryOperator()
    }

    class ProfileRead(val operator:Operator,val home:JSONObject?=null,val useRecentHome:Boolean=false)

    fun restore(includeHome:Boolean=false,canReuseHome:(SavedNativeSession)->Boolean={false},
        wantsHome:(String?,String)->Boolean={_,_->true}):ProfileRead?{
        // Snapshot, validate and attach under one process-wide lock. A second
        // activity with the same saved bearer joins the existing generation.
        val restored=synchronized(authority){
            val signedOut=signedOutStore.read()!=null
            val raw=sessionStore.read()
            clearMemoryOperator()
            if(signedOut){
                if(raw!=null)runCatching{transferMarkedSignOut(raw)}
                runCatching{cacheStore.clear()}
                return@synchronized null
            }
            if(raw==null)return@synchronized null
            val saved=try{SavedNativeSession.decode(raw)}catch(_:ContractFailure){
                authority.retire(::clearLocalOperator)
                return@synchronized null
            }
            if(configuredGroup!=null&&saved.groupId!=configuredGroup){
                if(!authority.hasActive())authority.retire(::clearLocalOperator)
                return@synchronized null
            }
            if(hasPendingSignOut(saved)){authority.retire(::clearLocalOperator);return@synchronized null}
            val witness=authority.attach(saved.token){w->
                boundGroup=saved.groupId
                if(saved.pendingPasscode?.stage==PasscodeStage.PREPARED)saveSession(saved.withoutPasscode())
                ownedWitness=w
                lastOwned=LocalOwnership(saved.groupId,saved.owner,Values.sha256(w.token))
            }
            witness to saved
        }
        val (witness,saved)=restored?:return null
        // The checkpoint selects work only. It can block on local storage, so
        // neither authority nor the shared profile lock can be held here.
        val loadHome=includeHome&&saved.pendingPasscode?.stage!=PasscodeStage.INFLIGHT&&wantsHome(saved.owner,saved.groupId)
        return resumeAttachedSession(witness,saved,loadHome,canReuseHome)
    }
    fun login(phone:String,pin:String,includeHome:Boolean=false):ProfileRead {
        val normalizedPhone=Values.phone(phone);val normalizedPin=Values.pin(pin)
        val ticket=synchronized(authority){
            val raw=sessionStore.read()
            if(signedOutStore.read()!=null){
                raw?.let(::retainMarkedSignOut)
            }else{
                val saved=raw?.let(SavedNativeSession::decode)
                if(saved?.pendingPasscode?.stage==PasscodeStage.INFLIGHT)
                    throw ApiFailure("passcode_change_unconfirmed",503,true)
                if(saved!=null||authority.hasActive())throw ApiFailure("session_already_active",409)
            }
            authority.revision()
        }
        val context=mapOf<String,Any?>("generation" to ticket.toString())+
            (if(api.resolvesLoginScope)emptyMap() else mapOf("groupId" to groupId))
        val body=JSONObject().put("phone",normalizedPhone).put("pin",normalizedPin)
        val path="/v1/burimunsi/session/login"
        val bundle=includeHome&&api.resolvesLoginScope
        val j=JSONObject(try{
            api.call("POST",if(bundle)"$path?include=home"else path,body=body,contractContext=context)
        }catch(e:ApiFailure){
            // Older servers reject the query before authenticating. A reply
            // that might follow a committed sign-in cannot justify a second POST.
            if(!bundle||e.uncertain||e.status!=400||e.code !in setOf("invalid_query","contract_query"))throw e
            api.call("POST",path,body=body,contractContext=context)
        })
        val selected=if(j.has("groupId"))Values.id(j.getString("groupId")) else if(api.resolvesLoginScope)throw ApiFailure("invalid_api_response") else groupId
        val expiry=j.getLong("expiresAt")
        val t=j.getString("token");check(isNativeBearer(t))
        val profileJson=j.getJSONObject("profile")
        val profile=operator(profileJson,expiry)
        try{
            if(configuredGroup!=null&&selected!=configuredGroup)throw ApiFailure("scope_changed",403)
            check(expiry>System.currentTimeMillis())
            authority.installRevision(ticket,t){witness->
            val before=sessionStore.read();val marker=signedOutStore.read()
            try{
                if(marker!=null){
                    before?.let(::retainMarkedSignOut)
                }else{
                    val previous=before?.let(SavedNativeSession::decode)
                    if(previous?.pendingPasscode?.stage==PasscodeStage.INFLIGHT)
                        throw ApiFailure("passcode_change_unconfirmed",503,true)
                    if(previous!=null)throw ApiFailure("session_already_active",409)
                }
                saveSession(SavedNativeSession.encode(t,selected,expiry,profileJson))
                signedOutStore.clear();check(signedOutStore.read()==null){"Protected sign-out marker could not be removed"}
                cacheStore.clear()
            }catch(e:Exception){
                runCatching{if(before==null)sessionStore.clear() else sessionStore.write(before);if(marker!=null)signedOutStore.write(marker)}
                throw e
            }
            boundGroup=selected;operator=profile;ownedWitness=witness;lastOwned=LocalOwnership(selected,profile.id,Values.sha256(t));lastReadFromCache=false;lastReadSavedAt=System.currentTimeMillis()
        }}catch(e:Exception){
            // Server sign-in can succeed after this instance was superseded.
            // Keep its exact returned token only as a revocation obligation.
            try{retainSignOut(t,selected,profile.id)}catch(_:Exception){
                val context=mapOf<String,Any?>("groupId" to selected,"generation" to "0","actorId" to profile.id)
                val revoked=runCatching{JSONObject(api.call("POST","/v1/burimunsi/session/logout",t,JSONObject(),contractContext=context)).getBoolean("signedOut")}.getOrDefault(false)
                if(!revoked)throw ApiFailure("login_cleanup_unconfirmed",503,true)
            }
            throw e
        }
        return ProfileRead(profile,j.optJSONObject("home"))
    }
    private fun resumeAttachedSession(
        witness:SessionWitness,saved:SavedNativeSession,includeHome:Boolean=false,
        canReuseHome:(SavedNativeSession)->Boolean={false},
    ):ProfileRead =
        synchronized(sessionRefreshLock){
            try{
                val pending=saved.pendingPasscode
                if(pending?.stage==PasscodeStage.INFLIGHT)
                    ProfileRead(recoverPasscode(witness,pending.token,checkNotNull(saved.owner)))
                else {
                    val useRecent=includeHome&&api.resolvesLoginScope&&canReuseHome(saved)
                    val confirmed=refreshSessionLocked(witness,saved.owner,includeHome&&!useRecent)
                    ProfileRead(confirmed.operator,confirmed.home,useRecent)
                }
            }catch(error:Exception){
                // Settle this failed read before another refresh of the same
                // witness can publish. A replacement never inherits this cleanup.
                val revoked=when(error){
                    is ApiFailure->confirmedSessionDenial(error)
                    is ContractFailure->error.code=="session_changed"
                    else->false
                }
                if(!revoked||!authority.invalidateIfCurrent(witness,::clearLocalOperator))clearMemoryFor(witness)
                throw error
            }
        }

    fun refreshSession(includeHome:Boolean=false):ProfileRead {
        val witness=ownedSession()
        return synchronized(sessionRefreshLock){refreshSessionLocked(witness,expectedOwner=null,includeHome)}
    }
    private fun readSession(witness:SessionWitness,includeHome:Boolean):JSONObject {
        if(includeHome&&api.resolvesLoginScope){
            try{return JSONObject(requestOwned(witness,"GET","/session?include=home"))}
            catch(e:ApiFailure){
                // A previous backend can reject the new query before loading records.
                if(e.status!=400||e.code !in setOf("invalid_query","contract_query"))throw e
            }
        }
        return JSONObject(requestOwned(witness,"GET","/session"))
    }
    private fun refreshSessionLocked(witness:SessionWitness,expectedOwner:String?,includeHome:Boolean=false):ProfileRead {
        val j=try{readSession(witness,includeHome)}catch(e:ApiFailure){
            if(e.status==403&&confirmedSessionDenial(e)){authority.invalidateIfCurrent(witness,::clearLocalOperator);throw ApiFailure("session_unavailable",401)}
            throw e
        }
        return authority.withCurrent(witness){
            if(j.has("groupId")&&j.getString("groupId")!=groupId){
                authority.invalidateIfCurrent(witness,::clearLocalOperator)
                throw ContractFailure("session_changed")
            }
            val profileJson=j.getJSONObject("profile")
            val profile=operator(profileJson,j.getLong("expiresAt"))
            val prior=operator
            if(profile.expiresAt<=System.currentTimeMillis()||(prior!=null&&prior.id!=profile.id)||
                (expectedOwner!=null&&expectedOwner!=profile.id)){
                authority.invalidateIfCurrent(witness,::clearLocalOperator)
                throw ContractFailure("session_changed")
            }
            // A revalidated session may have a renewed deadline. Persist the
            // exact server result before exposing the operator to the UI.
            val saved=readOwnedSession(witness)
            checkContract(saved.owner==null||saved.owner==profile.id,"session_changed")
            // Preserve any exact in-flight passcode candidate while persisting a
            // delayed refresh of this same predecessor session.
            // Older records can retain just the expected actor. The server response above is the current grant.
            val savedProfile=saved.operatorOrNull()
            try{if(savedProfile!=profile)saveSession(saved.withConfirmedProfile(profileJson,profile.expiresAt))}
            catch(e:Exception){authority.blockObservationIfCurrent(witness);throw e}
            lastReadFromCache=false;lastReadSavedAt=System.currentTimeMillis()
            operator=profile
            if(savedProfile!=null&&!profile.hasSameAccess(savedProfile)){
                authority.renewGrant(witness){ownedWitness=it}
            }else authority.confirmObservationCurrent(witness)
            ProfileRead(profile,j.optJSONObject("home"))
        }
    }
    private fun saveSession(encoded:String){
        sessionStore.write(encoded)
        check(sessionStore.read()==encoded){"Protected session could not be saved"}
    }
    private fun readOwnedSession(witness:SessionWitness): SavedNativeSession {
        val saved=readSavedSession()?:throw ContractFailure("session_changed")
        checkContract(saved.token==witness.token&&saved.groupId==groupId,"session_changed")
        return saved
    }
    private fun pendingSession(witness:SessionWitness,candidate:String,stage:PasscodeStage): SavedNativeSession {
        val saved=readOwnedSession(witness)
        val pending=saved.pendingPasscode
        checkContract(pending?.token==candidate&&pending.stage==stage,"session_changed")
        return saved
    }
    fun hasInflightPasscode(witness:SessionWitness):Boolean = synchronized(authority){
        try{
            val saved=readSavedSession()
            saved?.token==witness.token&&saved.pendingPasscode?.stage==PasscodeStage.INFLIGHT
        }catch(_:Exception){true} // Do not erase a damaged or unavailable protected record as a guess.
    }
    private fun installPasscodeSession(witness:SessionWitness,candidate:String,profileJson:JSONObject,expiry:Long,expectedOwner:String):Operator {
        val profile=operator(profileJson,expiry)
        checkContract(profile.id==expectedOwner&&expiry>System.currentTimeMillis(),"session_changed")
        authority.replaceCurrentWithWitness(witness,candidate){nextWitness->
            val saved=pendingSession(witness,candidate,PasscodeStage.INFLIGHT)
            checkContract(saved.owner==expectedOwner,"session_changed")
            saveSession(saved.withReplacement(candidate,profileJson,expiry))
            operator=profile;ownedWitness=nextWitness;lastOwned=LocalOwnership(groupId,profile.id,Values.sha256(candidate));lastReadFromCache=false;lastReadSavedAt=System.currentTimeMillis()
        }
        return profile
    }
    private fun recoverPasscode(witness:SessionWitness,candidate:String,owner:String):Operator {
        val selected=authority.withCurrent(witness){groupId}
        // This is only a candidate proof read. A 401 cannot establish that the
        // original POST will never commit, so leave the pending credential intact.
        val reply=try{api.call("GET","/v1/burimunsi/session",candidate,contractContext=
            mapOf("groupId" to selected,"generation" to witness.generation.toString(),"actorId" to owner))}
        catch(_:Exception){throw ApiFailure("passcode_change_unconfirmed",503,true)}
        val value=try{JSONObject(reply)}catch(_:Exception){throw ApiFailure("passcode_change_unconfirmed",503,true)}
        checkContract(!value.has("groupId")||value.getString("groupId")==selected,"session_changed")
        return installPasscodeSession(witness,candidate,value.getJSONObject("profile"),value.getLong("expiresAt"),owner)
    }
    fun current():Operator? {
        val witness=ownedWitness?:return null
        return try{authority.withCurrent(witness){operator}}catch(_:ContractFailure){null}
    }
    /** Publish a server-returned profile while its exact local authority is current. The callback must not block. */
    internal fun <T> withCurrentProfile(profile:Operator, publish:(String,Long)->T):T {
        val witness=ownedWitness?:throw ContractFailure("session_changed")
        return authority.withCurrent(witness){
            checkContract(operator===profile,"session_changed")
            publish(groupId,witness.generation)
        }
    }
    /** Join only an already-active same-owner/group replacement. A logout or
     * account switch never opens a fresh process slot through this path. */
    fun reattachSameOwner(owner:String,collection:String):Operator? {
        Values.id(owner);Values.id(collection)
        val (witness,saved)=synchronized(authority){
            if(!authority.hasActive()||signedOutStore.read()!=null)return null
            val saved=readSavedSession()?:return null
            if(saved.groupId!=collection||saved.owner!=owner||saved.pendingPasscode!=null)return null
            val witness=authority.attach(saved.token){w->
                if(ownedWitness!=w)clearMemoryOperator()
                boundGroup=collection
                ownedWitness=w
                lastOwned=LocalOwnership(collection,owner,Values.sha256(w.token))
            }
            witness to saved
        }
        return resumeAttachedSession(witness,saved).operator
    }
    fun observeProcessSession(listener:()->Unit):()->Unit=authority.observe(listener)
    fun hasPendingPasscode():Boolean = synchronized(authority){
        try{signedOutStore.read()==null&&readSavedSession()?.pendingPasscode?.stage==PasscodeStage.INFLIGHT}
        catch(_:Exception){true}
    }
    fun hasSavedSession():Boolean=try{signedOutStore.read()==null&&sessionStore.read()!=null}catch(_:Exception){true}
    fun clearOperator(){ownedWitness?.let{authority.invalidateIfCurrent(it,::clearLocalOperator)} /* NEVER touches receiving queue or gateway grants. */}
    private fun retainSignOut(saved:SavedNativeSession):String? =
        retainSignOut(saved.token,saved.groupId,saved.owner,saved.pendingPasscode?.token)

    private fun retainMarkedSignOut(encoded:String){
        val proof=SavedNativeSession.decodeRevocationProof(encoded)
        retainSignOut(proof.token,proof.groupId,proof.owner,proof.candidate)
    }

    private fun transferMarkedSignOut(encoded:String){
        retainMarkedSignOut(encoded)
        sessionStore.clear()
        check(sessionStore.read()==null){"Protected session could not be removed"}
    }

    private fun retainSignOut(old:String,group:String,owner:String?,candidate:String?=null):String? {
        return synchronized(signOutLock){
            val stored=revocationStore.read()?.let(::JSONObject)?:JSONObject().put("entries",JSONArray())
            val existing=stored.getJSONArray("entries");checkContract(existing.length()<=50,"operation_store_unavailable")
            if((0 until existing.length()).any{i->val item=existing.getJSONObject(i)
                item.getString("groupId")==group&&item.getString("token")==old&&
                    (if(item.has("candidate"))item.getString("candidate") else null)==candidate})return@synchronized null
            checkContract(existing.length()<50,"operation_store_unavailable")
            val next=JSONArray();for(i in 0 until existing.length())next.put(existing.getJSONObject(i))
            val id=UUID.randomUUID().toString()
            val item=JSONObject().put("id",id).put("groupId",group).put("token",old)
            if(candidate!=null)item.put("candidate",candidate)
            if(owner!=null)item.put("actorId",owner)
            next.put(item);val encoded=JSONObject().put("entries",next).toString()
            revocationStore.write(encoded)
            check(revocationStore.read()==encoded){"Protected sign-out obligation could not be saved"}
            id
        }
    }
    private fun hasPendingSignOut(saved:SavedNativeSession):Boolean=synchronized(signOutLock){
        pendingSignOut(saved,revocationStore.read())
    }
    /** Retry only revocation; network calls never hold the journal lock and
     * these proofs can never be installed as a login. */
    fun retryPendingSignOuts():Boolean {
        // Finish a crash-interrupted local transfer first. The authority lock
        // excludes a new login while its signed-out marker is being cleared.
        var transferComplete=true
        val snapshot=synchronized(authority){
            try{
                if(signedOutStore.read()!=null)
                    sessionStore.read()?.let(::transferMarkedSignOut)
            }catch(_:Exception){transferComplete=false}
            // An in-progress login can stage the displaced proof before it
            // commits its replacement. Snapshot admission shares its lock, so
            // a rollback can remove that staged proof before any network call.
            synchronized(signOutLock){
                if(signOutRetryRunning)return false
                val raw=revocationStore.read()?:return transferComplete
                val entries=JSONObject(raw).getJSONArray("entries");checkContract(entries.length()<=50,"operation_store_unavailable")
                val copy=(0 until entries.length()).map{JSONObject(entries.getJSONObject(it).toString())}
                signOutRetryRunning=true;copy
            }
        }
        try{
            val confirmed=mutableMapOf<String,Triple<String,String,String?>>()
            for(item in snapshot){
                val id=Values.requestId(item.getString("id"));val group=Values.id(item.getString("groupId"));val old=item.getString("token")
                val candidate=if(item.has("candidate"))item.getString("candidate") else null
                checkContract(isNativeBearer(old)&&(candidate==null||isNativeBearer(candidate)&&candidate!=old),
                    "operation_store_unavailable")
                val context=mapOf<String,Any?>("groupId" to group,"generation" to "0")+
                    (if(item.has("actorId"))mapOf("actorId" to Values.id(item.getString("actorId"))) else emptyMap())
                val body=JSONObject();if(candidate!=null)body.put("replacementToken",candidate)
                val committed=try{
                    JSONObject(api.call("POST","/v1/burimunsi/session/logout",old,body,contractContext=context)).getBoolean("signedOut")
                }catch(_:Exception){false}
                if(committed)confirmed[id]=Triple(group,old,candidate)
            }
            val complete=synchronized(signOutLock){
                val current=revocationStore.read()?.let(::JSONObject)?.getJSONArray("entries")?:return@synchronized true
                checkContract(current.length()<=50,"operation_store_unavailable")
                val remaining=JSONArray()
                for(i in 0 until current.length()){
                    val item=current.getJSONObject(i);val id=Values.requestId(item.getString("id"))
                    val candidate=if(item.has("candidate"))item.getString("candidate") else null
                    if(confirmed[id]!=Triple(item.getString("groupId"),item.getString("token"),candidate))remaining.put(item)
                }
                if(remaining.length()==0){revocationStore.clear();check(revocationStore.read()==null){"Protected sign-out obligation could not be removed"}}
                else{
                    val encoded=JSONObject().put("entries",remaining).toString();revocationStore.write(encoded)
                    check(revocationStore.read()==encoded){"Protected sign-out obligation could not be saved"}
                }
                remaining.length()==0
            }
            return complete&&transferComplete
        }finally{synchronized(signOutLock){signOutRetryRunning=false}}
    }
    fun logout(){
        // Invalidate the local generation before the network; a delayed PIN
        // response or restore can never install another local credential.
        var localUnconfirmed=false;var remoteProofLost=false;var localClearFailed=false
        val witness=synchronized(authority){
            val owned=ownedWitness
            val stillCurrent=owned!=null&&runCatching{authority.withCurrent(owned){true}}.getOrDefault(false)
            if(stillCurrent)owned else readSavedSession()?.let{saved->
                // A stale activity may sign out the replacement only if it is
                // still the same account and group as its last local operator.
                val prior=lastOwned?:throw ContractFailure("session_changed")
                val same=saved.groupId==prior.group&&(if(prior.owner!=null)saved.owner==prior.owner else Values.sha256(saved.token)==prior.tokenHash)
                if(!same)
                    throw ContractFailure("session_changed")
                // Never recreate a cleared process slot just to sign it out.
                if(authority.hasActive())authority.attach(saved.token){} else null
            }
        }
        authority.retireOwned(witness){
            val marked=try{signedOutStore.write("signed-out");check(signedOutStore.read()=="signed-out");true}
            catch(_:Exception){localUnconfirmed=true;false}
            val transferred=try{
                if(marked)sessionStore.read()?.let(::retainMarkedSignOut)
                else readSavedSession()?.let(::retainSignOut)
                true
            }
            catch(_:Exception){localUnconfirmed=true;false}
            if(!transferred&&!marked)remoteProofLost=true
            if(transferred||!marked){
                try{clearLocalOperator()}catch(_:Exception){clearMemoryOperator();localUnconfirmed=true;localClearFailed=true}
            }else{
                // The marker prevents restoration while this encrypted proof
                // waits for a durable transfer on a later launch/sign-in.
                clearMemoryOperator();runCatching{cacheStore.clear()}
            }
        }
        if(remoteProofLost)throw ApiFailure(if(localClearFailed)"logout_local_unconfirmed" else "logout_unconfirmed_no_retry",503,true)
        if(localUnconfirmed||!runCatching{retryPendingSignOuts()}.getOrDefault(false))throw ApiFailure("logout_unconfirmed",503,true)
    }
    override fun requestOwned(
        witness: SessionWitness,
        method: String,
        path: String,
        body: JSONObject?,
        recoveryOrigin: String?,
    ): String = callOwned(witness, method, path, body, recoveryOrigin, publishProvenance = true)

    internal fun requestUnpublishedHome(witness: SessionWitness): String =
        callOwned(witness, "GET", "/home", null, null, publishProvenance = false)

    private fun callOwned(
        witness: SessionWitness,
        method: String,
        path: String,
        body: JSONObject?,
        recoveryOrigin: String?,
        publishProvenance: Boolean,
    ): String {
        val binding=authority.withCurrent(witness){
            mapOf("groupId" to groupId,"generation" to witness.generation.toString()) +
                (operator?.id?.let{mapOf("actorId" to it)} ?: emptyMap())
        }
        try{
            val value=api.call(method,"/v1/burimunsi$path",witness.token,body,recoveryOrigin=recoveryOrigin,
                contractContext=binding)
            return authority.withCurrent(witness){
                if(publishProvenance)markRead(System.currentTimeMillis(),fromCache=false)
                value
            }
        }catch(e:ApiFailure){
            // A malformed/truncated response after a passcode POST may hide a
            // committed rotation even when its HTTP status was 401. A separate
            // old-session request may also see 401 after that rotation commits.
            if(e.status in setOf(401,403)&&hasInflightPasscode(witness)&&
                (path!="/session/passcode"||e.uncertain)){
                authority.invalidateIfCurrent(witness,::clearMemoryOperator)
                throw ApiFailure("passcode_change_unconfirmed",503,true)
            }
            if((e.status==401||e.status==403&&path.substringBefore('?')=="/session")&&!confirmedSessionDenial(e))
                throw ApiFailure("session_revalidation_unavailable",503,false)
            if(e.status==401&&confirmedSessionDenial(e))authority.invalidateIfCurrent(witness,::clearLocalOperator)
            throw e
        }
    }
    fun request(method:String,path:String,body:JSONObject?=null):String=
        requestOwned(ownedSession(),method,path,body)

    fun changePin(current:String,next:String,confirm:String):Operator{
        val currentPin=Values.pin(current);val newPin=Values.pin(next);Values.pin(confirm)
        checkContract(newPin==confirm,"passcodes_do_not_match")
        checkContract(currentPin!=newPin,"passcode_unchanged")
        val witness=ownedSession()
        val candidate=ByteArray(32).also{SecureRandom().nextBytes(it)}.joinToString(""){"%02x".format(it.toInt() and 255)}
        val owner=authority.withCurrent(witness){
            val who=operator?:throw ApiFailure("session_unavailable",401)
            val saved=readOwnedSession(witness)
            checkContract(saved.owner==who.id&&saved.pendingPasscode==null,"session_changed")
            saveSession(saved.withPreparedPasscode(candidate))
            who.id
        }
        authority.withCurrent(witness){
            val saved=pendingSession(witness,candidate,PasscodeStage.PREPARED)
            saveSession(saved.withInflightPasscode())
        }
        val body=JSONObject().put("current",currentPin).put("newPin",newPin).put("confirm",confirm).put("replacementToken",candidate)
        val reply=try{requestOwned(witness,"POST","/session/passcode",body)}catch(e:ApiFailure){
            if(!e.uncertain&&(e.status==0||e.status in 400..499&&e.status !in setOf(408,425,429))){
                // A definite rejection cannot have changed the PIN.
                runCatching{authority.withCurrent(witness){
                    saveSession(pendingSession(witness,candidate,PasscodeStage.INFLIGHT).withoutPasscode())
                }}
                throw e
            }
            // Preserve the candidate durably and disable old in-memory authority.
            // Recovery checks the candidate, and never repeats the PIN change.
            authority.invalidateIfCurrent(witness,::clearMemoryOperator)
            throw ApiFailure("passcode_change_unconfirmed",503,true)
        }catch(e:ContractFailure){
            // A concurrent old-session 401 may have retired this witness while
            // the server was committing the passcode change. Logout, by
            // contrast, removes the saved pending record and must stay final.
            if(e.code=="session_changed"&&hasInflightPasscode(witness))throw ApiFailure("passcode_change_unconfirmed",503,true)
            throw e
        }
        try{
            val value=JSONObject(reply)
            checkContract(value.getBoolean("reauthenticationRequired")==false,"invalid_api_response")
            val expiry=value.getLong("expiresAt")
            val saved=authority.withCurrent(witness){pendingSession(witness,candidate,PasscodeStage.INFLIGHT)}
            return installPasscodeSession(witness,candidate,checkNotNull(saved.profile),expiry,owner)
        }catch(e:ContractFailure){
            if(e.code=="session_changed")throw e
            authority.invalidateIfCurrent(witness,::clearMemoryOperator)
            throw ApiFailure("passcode_change_unconfirmed",503,true)
        }catch(_:Exception){
            authority.invalidateIfCurrent(witness,::clearMemoryOperator)
            throw ApiFailure("passcode_change_unconfirmed",503,true)
        }
    }
}
