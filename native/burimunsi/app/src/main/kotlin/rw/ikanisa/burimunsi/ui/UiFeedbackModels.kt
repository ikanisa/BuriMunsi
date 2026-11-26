package rw.ikanisa.burimunsi.ui

import rw.ikanisa.burimunsi.core.Route
import rw.ikanisa.burimunsi.core.ScreenGate
import rw.ikanisa.burimunsi.core.ScreenPresentation
import rw.ikanisa.burimunsi.core.export.ExportFormat

/** Real work and confirmed SAF outcomes; animations never advance these states. */
enum class UiOperation { NONE, INITIAL_READ, SIGN_IN, REFRESH, LOAD_MORE, COMMAND, EXPORT }
enum class UiExportPhase { PREPARING, CHOOSING_DESTINATION, WRITING, COMPLETE, CANCELLED, FAILED }
data class UiExportFeedback(
    val phase:UiExportPhase,val format:ExportFormat,val fileName:String?=null,
    val completedRows:Int?=null,val totalRows:Int?=null,val canCancel:Boolean=false,val error:String?=null,
)

internal fun hasOperationProgress(operation:UiOperation,busy:Boolean,export:UiExportFeedback?):Boolean =
    (busy || operation!=UiOperation.NONE) && operation!=UiOperation.LOAD_MORE &&
        !(operation==UiOperation.EXPORT && export!=null)

/** A form, sheet, first read or page footer presents its own pending action. */
internal fun UiState.showsRouteProgress(operation:UiOperation,gate:ScreenGate,presentation:ScreenPresentation,
    sheetOpen:Boolean,waitingForRoute:Boolean,export:UiExportFeedback?):Boolean {
    val signingIn=route==Route.LOGIN && busy && operation==UiOperation.SIGN_IN
    val waitingForWallet=route==Route.HOME && home!=null && home.paymentTotals==null && homeSavingsLoading
    return gate==ScreenGate.OPEN && !sheetOpen && !waitingForRoute && (operator==null || presentation.showRecords) &&
        !signingIn && !waitingForWallet && hasOperationProgress(operation,busy,export)
}
