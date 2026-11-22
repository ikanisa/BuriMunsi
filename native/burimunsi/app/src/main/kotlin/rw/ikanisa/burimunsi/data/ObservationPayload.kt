package rw.ikanisa.burimunsi.data

import org.json.JSONObject
import rw.ikanisa.burimunsi.core.ObservationReconcileRequest
import rw.ikanisa.burimunsi.core.SmsObservation
import rw.ikanisa.burimunsi.core.Values
import rw.ikanisa.burimunsi.core.checkContract

internal fun observationBody(observation:SmsObservation):JSONObject {
    val body=JSONObject().put("requestId",observation.requestId).put("rawSender",observation.rawSender)
        .put("rawBody",observation.rawBody).put("sourceMode",observation.sourceMode).put("complete",observation.complete)
        .put("capturedAt",observation.capturedAt).put("serviceCentreAt",observation.serviceCentreAt?:JSONObject.NULL)
        .put("inboxReceivedAt",observation.inboxReceivedAt?:JSONObject.NULL).put("subscriptionId",observation.subscriptionId?:JSONObject.NULL)
    observation.sourceKey?.let{body.put("sourceKey",it)}
    return body
}

internal fun reconciliationItem(request:ObservationReconcileRequest):JSONObject {
    checkContract(Regex("[a-f0-9]{64}").matches(request.sourceKey)&&Regex("[a-f0-9]{64}").matches(request.bodySha256),
        "invalid_observation_source")
    return JSONObject().put("sourceKey",request.sourceKey).put("bodySha256",request.bodySha256)
        .put("rawSender",request.rawSender).put("serviceCentreAt",request.serviceCentreAt?:JSONObject.NULL)
        .put("inboxReceivedAt",request.inboxReceivedAt).put("subscriptionId",request.subscriptionId?:JSONObject.NULL)
        .also{body->request.gatewayEnvelopeId?.let{body.put("gatewayEnvelopeId",Values.requestId(it))}}
}
