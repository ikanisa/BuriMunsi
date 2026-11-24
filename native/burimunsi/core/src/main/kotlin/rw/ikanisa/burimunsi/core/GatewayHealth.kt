package rw.ikanisa.burimunsi.core

/** Describes local capture evidence, never financial settlement or bank availability. */
data class GatewayDiagnosis(
    val code:String, val title:String, val explanation:String,
    val canPair:Boolean=false, val needsPermission:Boolean=false,
    val canPause:Boolean=false, val canResume:Boolean=false,
)
object GatewayHealth {
    fun describe(g:GatewayStatus?):GatewayDiagnosis {
        if(g==null)return GatewayDiagnosis("unavailable","Status unavailable",
            "Refresh the receiving-phone status.")
        val problem=g.problem?.trim()?.takeIf{it.isNotEmpty()}
        val pause=g.authorized&&g.captureEnabled
        if(problem=="qualification_offline")return GatewayDiagnosis("qualification","Offline qualification",
            "This build cannot pair or upload receipts. Use it only for the documented offline checks.")
        if(problem=="authorization_required")return GatewayDiagnosis("reauthorize","Authorization required",
            "Sign in with an Admin account to resume receiving payment SMS.",canPause=pause)
        if(g.pending<0||problem=="queue_unavailable")return GatewayDiagnosis("queue","Queue unavailable",
            "The retained-receipt count is unknown. Do not clear app data or reinstall to resolve this; contact the administrator.",canPause=pause)
        if(g.observationMode){
            if(problem=="permission_required")return GatewayDiagnosis("permissions","SMS access required",
                "Review the requested Android permissions.",needsPermission=true,canPause=g.captureEnabled)
            if(problem=="observation_paused")return GatewayDiagnosis("paused","Sync paused",
                "Previously retained receipts are not erased.",canResume=true)
            if(problem=="observation_waiting")return GatewayDiagnosis("waiting","Sync pending",
                "The approved provider profile and consent must be confirmed before sync.",canPause=true)
            return GatewayDiagnosis("observation","Sync enabled",
                "Messages sync automatically.",canPause=true)
        }
        if(!g.authorized)return GatewayDiagnosis("pair","Pair receiving phone",
            "Use the administrator-issued pairing code for this receiving phone.",canPair=true)
        if(problem=="permission_required")return GatewayDiagnosis("permissions","SMS access required",
            "Allow the requested Android SMS and phone permissions to receive payments automatically.",needsPermission=true,canPause=pause)
        if(g.subscriptionId==null||g.subscriptionId<0)return GatewayDiagnosis("source","SIM source not verified",
            "The bound Android subscription is unavailable. Ask the administrator to verify the business SIM; do not relabel retained receipts.",canPause=pause)
        if(problem!=null&&problem!="uploads_on_hold")return GatewayDiagnosis("attention","Receiving needs attention",
            "Refresh the status and contact the administrator. Do not infer successful processing from a heartbeat or a network connection.",canPause=pause)
        if(problem=="uploads_on_hold")return GatewayDiagnosis("hold","Uploads on hold",
            "Upload is paused. This phone can keep receiving messages.",canPause=pause,canResume=!g.captureEnabled)
        if(!g.captureEnabled)return GatewayDiagnosis("paused","Sync paused",
            "New-message sync is paused. Previously retained receipts are not erased by pausing; review the queue before resuming.",canResume=true)
        if(g.pending>0)return GatewayDiagnosis("pending","Receipts waiting",
            "Messages are waiting to sync.",canPause=true)
        return GatewayDiagnosis("capture","Sync enabled",
            "This phone is listening for M-Money SMS.",canPause=true)
    }
}
