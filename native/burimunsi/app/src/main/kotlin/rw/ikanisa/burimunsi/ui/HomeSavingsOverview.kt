package rw.ikanisa.burimunsi.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.cool.mobile.R
import rw.ikanisa.burimunsi.core.HomeSavings
import rw.ikanisa.burimunsi.core.SavingsReconciliation

@Composable
internal fun HomeSavingsOverview(savings:HomeSavings?) {
    val t=LocalUiText.current
    val lifetime=savings?.lifetimeContributionsRwf
    val lifetimeDescription=t("Lifetime member contributions")+" · "+
        (lifetime?.let { money(it,t.locale)+" "+t("RWF") } ?: t("Unavailable"))
    Column(Modifier.fillMaxWidth().padding(top=12.dp,bottom=4.dp),horizontalAlignment=Alignment.CenterHorizontally) {
        SavingsAmount(lifetime,primary=true,ink=BuriTheme.Text,unitInk=BuriTheme.Muted,
            modifier=Modifier.clearAndSetSemantics { heading(); contentDescription=lifetimeDescription })
        Spacer(Modifier.height(18.dp))
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val stacked=maxWidth < 256.dp * LocalDensity.current.fontScale + 8.dp
            if(stacked) {
                Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    SavingsCard(savings,wallet=false,modifier=Modifier.fillMaxWidth())
                    SavingsCard(savings,wallet=true,modifier=Modifier.fillMaxWidth())
                }
            } else {
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                    SavingsCard(savings,wallet=false,modifier=Modifier.weight(1f))
                    SavingsCard(savings,wallet=true,modifier=Modifier.weight(1f))
                }
            }
        }
        val message=when {
            savings==null -> t("Savings figures unavailable.")
            savings.reconciliationStatus==SavingsReconciliation.MISMATCH -> t("Contributions less outgoing payments differ from the last MoMo balance.")
            savings.reconciliationStatus==SavingsReconciliation.UNAVAILABLE -> t("Reconciliation unavailable from the verified records.")
            else -> null
        }
        if(message!=null) {
            Spacer(Modifier.height(8.dp))
            Text(message,fontSize=14.sp,lineHeight=20.sp,textAlign=TextAlign.Center,
                color=if(savings?.reconciliationStatus==SavingsReconciliation.MISMATCH)BuriTheme.Warn else BuriTheme.Muted)
        }
    }
}

@Composable
private fun SavingsCard(savings:HomeSavings?,wallet:Boolean,modifier:Modifier) {
    val t=LocalUiText.current
    val value=if(wallet)savings?.latestWalletBalanceRwf else savings?.outgoingPaymentsRwf
    val label=if(wallet)t("MoMo balance · last SMS")else t("Total outgoing payments")
    val amount=value?.let { money(it,t.locale)+" "+t("RWF") } ?: t("Unavailable")
    val at=if(wallet)savings?.lastWalletSmsAt?.let { historyTime(it,t.locale) } else null
    val description=listOfNotNull(label,amount,at).joinToString(" · ")
    val ink=if(wallet)Color(0xFF292447)else Color(0xFF15274C)
    Row(modifier.heightIn(min=60.dp)
        .background(if(wallet)Color(0xFFEBE8FF)else Color(0xFFE2EBFF),RoundedCornerShape(18.dp))
        .clearAndSetSemantics { contentDescription=description }.padding(horizontal=6.dp,vertical=12.dp),
        verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(5.dp,Alignment.CenterHorizontally)) {
        Glyph(if(wallet)R.drawable.ic_home_wallet else R.drawable.ic_home_outgoing,null,
            if(wallet)Color(0xFF55459B)else Color(0xFF2753A3),24)
        SavingsAmount(value,primary=false,ink=ink,unitInk=ink,modifier=Modifier.weight(1f,fill=false))
    }
}

@Composable
private fun SavingsAmount(value:Long?,primary:Boolean,ink:Color,unitInk:Color,modifier:Modifier) {
    val t=LocalUiText.current
    val baseSize=if(primary&&value!=null)64 else if(primary)32 else 19
    val text=buildAnnotatedString {
        if(value==null)append(t("Unavailable")) else {
            append(money(value,t.locale))
            withStyle(SpanStyle(color=unitInk,fontSize=(if(primary)23 else 13).sp,fontWeight=FontWeight.Medium)) {
                append(" "+t("RWF"))
            }
        }
    }
    Text(text,modifier=modifier,style=LocalTextStyle.current.copy(fontFeatureSettings="tnum"),
        color=ink,fontSize=baseSize.sp,lineHeight=(if(primary)baseSize+12 else 24).sp,
        fontWeight=if(primary)FontWeight.Medium else FontWeight.SemiBold,textAlign=TextAlign.Center)
}
