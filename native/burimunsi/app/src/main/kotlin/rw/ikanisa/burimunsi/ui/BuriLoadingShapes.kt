package rw.ikanisa.burimunsi.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import rw.ikanisa.burimunsi.core.Route

internal enum class LoadingRows { PAYMENTS, MEMBERS, MESSAGES, ACTIVITY, SETTINGS }

/** One pulse per group. Its value is read only while drawing the neutral geometry. */
@Composable private fun LoadingMark(modifier:Modifier, pulse:State<Float>, round:Boolean=false) {
    Canvas(modifier) {
        val radius=if(round)size.minDimension/2f else minOf(6.dp.toPx(),size.minDimension/2f)
        drawRoundRect(BuriTheme.Text.copy(alpha=.065f+.06f*pulse.value),cornerRadius=CornerRadius(radius))
    }
}

@Composable private fun Geometry(kind:String,content:@Composable (State<Float>)->Unit) {
    val pulse=workPhase(reverse=true)
    Box(Modifier.fillMaxWidth().testTag("loading-layout:$kind")) {
        Column(Modifier.fillMaxWidth().clearAndSetSemantics { this[SemanticsProperties.TestTag]="loading-skeleton" },
            verticalArrangement=Arrangement.spacedBy(10.dp)) { content(pulse) }
    }
}

@Composable private fun ListRows(type:LoadingRows,rows:Int,pulse:State<Float>) {
    Column(verticalArrangement=Arrangement.spacedBy(2.dp)) {
        repeat(rows) { index ->
            Row(Modifier.fillMaxWidth().background(BuriTheme.Group,rowShape(index==0,index==rows-1))
                .padding(horizontal=14.dp,vertical=14.dp),verticalAlignment=Alignment.CenterVertically,
                horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                if(type!=LoadingRows.ACTIVITY) LoadingMark(Modifier.size(40.dp),pulse,round=true)
                Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    LoadingMark(Modifier.fillMaxWidth(if(index%2==0).68f else .52f).height(13.dp),pulse)
                    LoadingMark(Modifier.fillMaxWidth(if(type==LoadingRows.MESSAGES).94f else .70f).height(8.dp),pulse)
                    if(type==LoadingRows.MESSAGES) LoadingMark(Modifier.fillMaxWidth(.42f).height(8.dp),pulse)
                }
                if(type==LoadingRows.PAYMENTS) LoadingMark(Modifier.width(49.dp).height(14.dp),pulse)
                if(type==LoadingRows.SETTINGS) LoadingMark(Modifier.size(13.dp),pulse,round=true)
            }
        }
    }
}

@Composable internal fun BuriSkeletonRows(rows:Int,style:LoadingRows) {
    Geometry(style.name) { pulse -> ListRows(style,rows,pulse) }
}

@Composable private fun WalletGeometry(pulse:State<Float>) {
    Column(Modifier.fillMaxWidth().padding(top=12.dp),horizontalAlignment=Alignment.CenterHorizontally,
        verticalArrangement=Arrangement.spacedBy(10.dp)) {
        LoadingMark(Modifier.fillMaxWidth(.44f).height(11.dp),pulse)
        LoadingMark(Modifier.fillMaxWidth(.58f).height(34.dp),pulse)
        // Keep the optional SMS balance private until the verified response supplies it.
        Column(Modifier.fillMaxWidth().background(BuriTheme.Tone,RoundedCornerShape(18.dp)).padding(14.dp),
            horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(8.dp)) {
            LoadingMark(Modifier.fillMaxWidth(.38f).height(10.dp),pulse)
            LoadingMark(Modifier.fillMaxWidth(.25f).height(15.dp),pulse)
        }
    }
}

@Composable internal fun BuriWalletSkeleton() {
    Geometry("WALLET") { pulse -> WalletGeometry(pulse) }
}

@Composable private fun FactGeometry(pulse:State<Float>) {
    Column(Modifier.fillMaxWidth().background(BuriTheme.Group,RoundedCornerShape(22.dp)).padding(16.dp),
        verticalArrangement=Arrangement.spacedBy(16.dp)) {
        repeat(3) { index ->
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                LoadingMark(Modifier.fillMaxWidth(.27f).height(10.dp),pulse)
                LoadingMark(Modifier.fillMaxWidth(if(index==1).67f else .47f).height(12.dp),pulse)
            }
        }
    }
}

@Composable internal fun BuriFactsSkeleton() {
    Geometry("FACTS") { pulse -> FactGeometry(pulse) }
}

@Composable private fun DetailGeometry(payment:Boolean,pulse:State<Float>) {
    Column(Modifier.fillMaxWidth(),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(12.dp)) {
        LoadingMark(Modifier.size(64.dp),pulse,round=true)
        LoadingMark(Modifier.fillMaxWidth(.57f).height(20.dp),pulse)
        LoadingMark(Modifier.fillMaxWidth(.38f).height(if(payment)34.dp else 12.dp),pulse)
        if(payment) FactGeometry(pulse)
        else repeat(2) { LoadingMark(Modifier.fillMaxWidth().height(46.dp),pulse,round=true) }
    }
}

@Composable internal fun BuriRouteSkeleton(route:Route,rows:Int) {
    if(route==Route.LOGIN)return
    Geometry(route.name) { pulse ->
        when(route) {
            Route.HOME -> {
                WalletGeometry(pulse)
                LoadingMark(Modifier.fillMaxWidth(.4f).height(15.dp),pulse)
                ListRows(LoadingRows.PAYMENTS,rows.coerceAtMost(3),pulse)
            }
            Route.PAYMENTS,Route.MEMBERS,Route.SMS -> {
                LoadingMark(Modifier.fillMaxWidth().height(48.dp),pulse,round=true)
                val tools=if(LocalDensity.current.fontScale>=1.5f).90f else .65f
                LoadingMark(Modifier.fillMaxWidth(tools).height(27.dp),pulse,round=true)
                val type=when(route) {
                    Route.PAYMENTS -> LoadingRows.PAYMENTS
                    Route.SMS -> LoadingRows.MESSAGES
                    else -> LoadingRows.MEMBERS
                }
                ListRows(type,rows,pulse)
            }
            Route.PAYMENT,Route.MEMBER -> DetailGeometry(route==Route.PAYMENT,pulse)
            Route.SETTINGS -> ListRows(LoadingRows.SETTINGS,rows,pulse)
            Route.LOGIN -> Unit
        }
    }
}
