package rw.ikanisa.burimunsi.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.cool.mobile.R
import java.text.NumberFormat
import rw.ikanisa.burimunsi.core.HomeSavings
import rw.ikanisa.burimunsi.core.HomeWalletTotals
import rw.ikanisa.burimunsi.core.Presentation

@Composable
internal fun HomeWalletOverview(totals: HomeWalletTotals?, smsAllowed: Boolean) {
    val t = LocalUiText.current
    val format = NumberFormat.getIntegerInstance(t.locale)
    val showSms = totals?.smsBalanceVisible == true && smsAllowed
    val incoming = totals?.let { format.format(it.incomingRwf) }
    val label = t("Cumulative incoming payments")
    val description = "$label · " + (incoming?.let { "$it " + t("RWF") } ?: t("Unavailable"))
    Column(Modifier.fillMaxWidth().padding(top=12.dp,bottom=4.dp),
        horizontalAlignment=Alignment.CenterHorizontally, verticalArrangement=Arrangement.spacedBy(8.dp)) {
        Column(Modifier.clearAndSetSemantics { heading(); contentDescription=description },
            horizontalAlignment=Alignment.CenterHorizontally) {
            Text(label, color=BuriTheme.Muted, fontSize=15.sp, lineHeight=21.sp, textAlign=TextAlign.Center)
            SavingsAmount(incoming,primary=true,ink=BuriTheme.Text,unitInk=BuriTheme.Muted)
        }
        val outgoing = totals?.let { format.format(it.outgoingRwf) }
        val balance = totals?.latestSmsBalanceRwf?.let { format.format(it) }
        WalletAmounts(
            outgoing = outgoing,
            outgoingLabel = t("Cumulative outgoing payments"),
            balance = balance,
            balanceLabel = if (showSms) t("Latest MoMo SMS balance") else null,
        )
        val gap = totals?.walletGapRwf
        if (showSms && gap != null && gap.signum() != 0) {
            val value = format.format(gap) + " " + t("RWF")
            Text(t("Wallet difference") + " · " + value, color=BuriTheme.Muted, fontSize=14.sp,
                textAlign=TextAlign.Center, lineHeight=20.sp)
        }
    }
}

@Composable
internal fun HomeSavingsOverview(savings:HomeSavings?) {
    val t=LocalUiText.current
    val lifetime=savings?.lifetimeContributionsRwf
    val lifetimeDescription=t("Lifetime member contributions")+" · "+
        (lifetime?.let { money(it,t.locale)+" "+t("RWF") } ?: t("Unavailable"))
    Column(Modifier.fillMaxWidth().padding(top=12.dp,bottom=4.dp),horizontalAlignment=Alignment.CenterHorizontally) {
        SavingsAmount(lifetime?.let { money(it,t.locale) },primary=true,ink=BuriTheme.Text,unitInk=BuriTheme.Muted,
            modifier=Modifier.clearAndSetSemantics { heading(); contentDescription=lifetimeDescription })
        Spacer(Modifier.height(12.dp))
        WalletAmounts(
            outgoing = savings?.outgoingPaymentsRwf?.let { money(it, t.locale) },
            outgoingLabel = t(if (savings.showsRecordedOutgoing()) "Recorded outgoing payments" else "Total outgoing payments"),
            balance = savings?.latestWalletBalanceRwf?.let { money(it, t.locale) },
            balanceLabel = t("MoMo balance · last SMS"),
        )
        val availabilityMessage = when {
            savings == null -> t("Savings figures unavailable.")
            savings.reconciliationStatus == "unavailable" -> t("Wallet reconciliation needs a verified opening balance and a complete record of payments and fees.")
            else -> null
        }
        if (availabilityMessage != null) {
            Spacer(Modifier.height(8.dp))
            Text(availabilityMessage, fontSize=14.sp, lineHeight=20.sp, textAlign=TextAlign.Center, color=BuriTheme.Muted)
        }
    }
}

private fun HomeSavings?.showsRecordedOutgoing():Boolean =
    this != null && reconciliationStatus=="unavailable" && outgoingPaymentsRwf!=null

@Composable
private fun WalletAmounts(outgoing: String?, outgoingLabel: String, balance: String?, balanceLabel: String?) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        SavingsCard(outgoing, outgoingLabel, R.drawable.ic_home_outgoing)
        if (balanceLabel != null) SavingsCard(balance, balanceLabel, R.drawable.ic_home_wallet)
    }
}

@Composable
private fun SavingsCard(formatted: String?, label: String, icon: Int) {
    val t = LocalUiText.current
    val amount=formatted?.let { it+" "+t("RWF") } ?: t("Unavailable")
    val description="$label · $amount"
    Row(Modifier.heightIn(min=36.dp)
        .background(BuriTheme.Tone,RoundedCornerShape(14.dp))
        .clearAndSetSemantics { contentDescription=description }
        .padding(horizontal=12.dp,vertical=6.dp),
        verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(4.dp)) {
        Glyph(icon,null,BuriTheme.Text,20)
        SavingsAmount(formatted,primary=false,ink=BuriTheme.Text,unitInk=BuriTheme.Text)
    }
}

@Composable
private fun SavingsAmount(value: String?, primary: Boolean, ink: Color, unitInk: Color, modifier: Modifier = Modifier) {
    val t = LocalUiText.current
    val digits = value?.count(Char::isDigit) ?: 0
    val extraDigits = (digits - if (primary) 5 else 4).coerceAtLeast(0)
    val preferredSize = when {
        primary && value == null -> 32
        primary -> (64 - 3 * extraDigits).coerceAtLeast(32)
        else -> (19 - (extraDigits + 1) / 2).coerceAtLeast(Presentation.MONEY_MIN_SP)
    }
    val weight = if (primary) 500 - 15 * extraDigits else 600 - 25 * extraDigits
    val style = LocalTextStyle.current.copy(
        color = ink, fontWeight = FontWeight(weight.coerceAtLeast(FontWeight.Normal.weight)),
        fontFeatureSettings = "tnum", textAlign = TextAlign.Center,
    )
    val unitScale = if (primary) minOf(23f / preferredSize, .55f) else 13f / preferredSize
    val text = buildAnnotatedString {
        if (value == null) append(t("Unavailable")) else {
            append(value)
            withStyle(SpanStyle(color = unitInk, fontSize = unitScale.em, fontWeight = FontWeight.Medium)) {
                append(" " + t("RWF"))
            }
        }
    }
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
        val widthPx = constraints.maxWidth
        val size = remember(text, style, preferredSize, widthPx, measurer) {
            fun fits(size: Int) = measurer.measure(
                text, style.copy(fontSize = size.sp), softWrap = false, maxLines = 1,
            ).size.width <= widthPx

            if (fits(preferredSize)) preferredSize else {
                var lower = Presentation.MONEY_MIN_SP
                var upper = preferredSize - 1
                while (lower < upper) {
                    val candidate = (lower + upper + 1) / 2
                    if (fits(candidate)) lower = candidate else upper = candidate - 1
                }
                lower
            }
        }
        // At the readable minimum, let the full amount and currency reflow on narrow screens.
        Text(text, style = style.copy(fontSize = size.sp, lineHeight = (size + if (primary) 12 else 5).sp))
    }
}
