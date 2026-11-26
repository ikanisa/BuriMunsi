package rw.ikanisa.burimunsi.data
import org.json.JSONObject
import rw.ikanisa.burimunsi.core.ContractFailure
import rw.ikanisa.wire.*

internal const val PAYMENT_REFERENCE_VERSION_HEADER = "X-BuriMunsi-Payment-Reference-Version"
internal const val HOME_SAVINGS_PATH = "/home?include=savings"
internal const val SESSION_HOME_SAVINGS_INCLUDE = "home_savings"
internal fun ApiFailure.isLegacyHomeSelectorRejection(): Boolean =
    status == 400 && code == "contract_query" && !uncertain

internal const val PAYMENT_DETAIL_V1 = "paymentDetailV1"

/** Cache entries are data, never authority. Revalidate them against the current owner and route. */
internal fun validateCachedPayload(installationId:String,path:String,payload:String,context:Map<String,Any?>):String {
    try {
        val contract=BuriMunsiSchemas.contract
        val data=objectValue(StrictJson.parse(payload))
        // Home has one encrypted cache entry; validate its exact negotiated wire shape.
        val wirePath=if(path=="/home"&&data.containsKey("savings")) HOME_SAVINGS_PATH else path
        val route=contract.route("GET",wirePath)
        val operation=if(route.first=="payment"&&data.containsKey("payment")) PAYMENT_DETAIL_V1 else route.first
        contract.validate(operation+".data",data)
        val binding=context+mapOf("installationId" to installationId)
        contract.semantics(operation,mapOf("binding" to binding,"data" to data),binding+mapOf("recordId" to route.second))
        return payload
    }catch(e:ContractViolation){throw ApiFailure(e.code.lowercase(),0,false)}
}
internal fun checkedDto(name:String,value:JSONObject) {
    try { BuriMunsiSchemas.contract.validate(name,StrictJson.parse(value.toString())) }
    catch(e:ContractViolation){throw ContractFailure(e.code.lowercase())}
}
