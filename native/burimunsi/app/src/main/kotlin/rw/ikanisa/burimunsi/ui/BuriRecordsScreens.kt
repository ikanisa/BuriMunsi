package rw.ikanisa.burimunsi.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role as SemanticRole
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.cool.mobile.R
import rw.ikanisa.burimunsi.core.*

internal val UiState.isMemberStatement:Boolean get() = route==Route.PAYMENTS && !routeId.isNullOrBlank()

@Composable private fun PaymentRow(p:Payment,first:Boolean=true,last:Boolean=true,preview:Boolean=false,
    statement:Boolean=false,opensStatement:Boolean=false,click:()->Unit){
    val t=LocalUiText.current
    val action=focusAction("payment:${p.id}",click)
    val status=PaymentPresentation.payment(p)
    val fontScale=LocalDensity.current.fontScale
    val direction=t(PaymentPresentation.directionLabel(p.direction))
    val directionIcon=when(p.direction){
        "incoming"->R.drawable.ic_payment_incoming
        "outgoing"->R.drawable.ic_payment_outgoing
        else->R.drawable.ic_activity
    }
    BoxWithConstraints(action.modifier.fillMaxWidth().heightIn(min=68.dp).background(BuriTheme.Group,rowShape(first,last)).clickable(
        role=SemanticRole.Button,onClickLabel=t(if(opensStatement)"Open member statement" else "Payment details"),onClick=action.click)
        .semantics(mergeDescendants=true){}.padding(horizontal=14.dp,vertical=12.dp)){
        val stacked=maxWidth<280.dp||fontScale>=1.5f
        Column(Modifier.fillMaxWidth()){
            Row(verticalAlignment=Alignment.CenterVertically){
                if(statement){
                    Box(Modifier.size(40.dp).background(BuriTheme.Tone,CircleShape),contentAlignment=Alignment.Center){
                        Glyph(directionIcon,null,BuriTheme.Text,22)
                    }
                }else Avatar(p.payerNameRaw,size=40,unallocated=p.state=="unallocated")
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)){
                    SingleLineName(if(statement)direction else p.payerNameRaw.ifBlank{t("Unavailable")},size=17)
                    p.atRaw.takeIf{it.isNotBlank()}?.let{rawTime ->
                        val timestamp = if (preview) ExactDisplay.recentPaymentTimestamp(rawTime, t.locale.toLanguageTag())
                            else historyTime(rawTime, t.locale)
                        CompactLabel(timestamp,style=MaterialTheme.typography.bodySmall,color=BuriTheme.Muted)
                    }
                    if(!preview)p.ftId?.let{CompactLabel(t("FT Id: %1\$s",it),style=MaterialTheme.typography.bodySmall,color=BuriTheme.Muted)}
                    if(!statement)when(p.direction) {
                        "incoming","outgoing" -> Glyph(directionIcon,direction,BuriTheme.Muted,22)
                        else -> CompactLabel(direction,style=MaterialTheme.typography.bodySmall,color=BuriTheme.Muted)
                    }
                }
                if(!stacked){
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.widthIn(max=140.dp),horizontalAlignment=Alignment.End){
                        MoneyText(p.amountRwf,size=20)
                        if(!statement)PaymentStatusLabel(status)
                    }
                }
            }
            if(stacked){
                Spacer(Modifier.height(8.dp))
                MoneyText(p.amountRwf,Modifier.fillMaxWidth(),20,showHint=true)
                if(!statement)PaymentStatusLabel(status)
            }
        }
        if(!last)HorizontalDivider(Modifier.align(Alignment.BottomCenter),color=Color.White.copy(alpha=.08f))
    }
}
@Composable private fun PaymentStatusLabel(status:PaymentStatus){
    val tone=stateTone(status.tone)
    Glyph(stateIcon(status.icon),LocalUiText.current(status.label),tone,24)
}
@Composable private fun MemberRow(member:Member,first:Boolean=true,last:Boolean=true,click:()->Unit){
    val t=LocalUiText.current
    val action=focusAction("member:${member.id}",click)
    Box(action.modifier.fillMaxWidth().heightIn(min=68.dp).background(BuriTheme.Group,rowShape(first,last)).clickable(role=SemanticRole.Button,onClick=action.click)
        .semantics(mergeDescendants=true){}.padding(horizontal=14.dp,vertical=12.dp)){
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
            Avatar(member.name,size=40);Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)){
                SingleLineName(member.name,size=17)
                CompactLabel(if(member.active)member.phone else t("%1\$s · %2\$s",member.phone,t("Inactive")),fontSize=14.sp,color=BuriTheme.Muted,lineHeight=22.sp)
            }
        }
        if(!last)HorizontalDivider(Modifier.align(Alignment.BottomCenter),color=Color.White.copy(alpha=.08f))
    }
}

@Composable internal fun HomeScreen(s:UiState,m:BuriController){
    val t=LocalUiText.current;val home=s.home
    LazyColumn(Modifier.fillMaxSize(),state=routeList(s,m),contentPadding=PaddingValues(20.dp,12.dp,20.dp,22.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
        if(home==null){item{if(s.busy){BuriInlineLoading("Loading records");BuriRouteSkeleton(Route.HOME,3)}else Empty(t("No records available"))};return@LazyColumn}
        item{
            val totals=home.paymentTotals
            when {
                totals != null -> HomeWalletOverview(totals,
                    smsAllowed = s.operator?.let { it.role == Role.ADMIN && Capability.SMS.key in it.capabilities } == true)
                s.homeSavingsLoading -> Column { BuriInlineLoading("Loading payment totals"); BuriWalletSkeleton() }
                s.homeWalletUnavailable -> HomeWalletOverview(null,smsAllowed=false)
                else -> HomeSavingsOverview(home.savings)
            }
        }
        if (m.allows(Capability.SMS)) item {
            Box(Modifier.fillMaxWidth().padding(vertical=5.dp),contentAlignment=Alignment.Center) {
                RoundAction(R.drawable.ic_sms,t("Messages"),{m.navigate(Route.SMS)},!s.busy,52)
            }
        }
        if(home.unallocatedCount>0)item{val label=t("%1\$d unallocated",home.unallocatedCount)
            Row(Modifier.fillMaxWidth().background(BuriTheme.Warn.copy(alpha=.075f),RoundedCornerShape(22.dp))
                .clickable(enabled=!s.busy,role=SemanticRole.Button,onClickLabel=t("Open unallocated")){m.openUnallocated()}
                .semantics { contentDescription=label }.padding(horizontal=16.dp,vertical=13.dp),verticalAlignment=Alignment.CenterVertically){
            Glyph(R.drawable.ic_unlinked,null,BuriTheme.Warn,26);Spacer(Modifier.width(12.dp))
            CompactLabel(money(home.unallocatedCount.toLong(),t.locale),Modifier.weight(1f).clearAndSetSemantics{},fontSize=18.sp,color=BuriTheme.Warn)
            Glyph(R.drawable.ic_arrow,null,BuriTheme.Warn,20)
        }}
        item{Row(Modifier.fillMaxWidth().heightIn(min=48.dp),verticalAlignment=Alignment.CenterVertically){
            CompactLabel(t("Recent"),Modifier.weight(1f).semantics{heading()},style=MaterialTheme.typography.headlineSmall)
            RoundAction(R.drawable.ic_arrow,t("All payments"),{m.navigate(Route.PAYMENTS)},!s.busy,48)
        }}
        val recent=home.recent.take(3)
        item(key="home-recent-payments"){
            if(recent.isEmpty()){
                Empty(t("No recent payments"))
            }else Column{recent.forEachIndexed{index,p->key(p.id){
                PaymentRow(p,index==0,index==recent.lastIndex,preview=true){m.navigate(Route.PAYMENT,p.id)}
            }}}
        }
    }
}

@Composable internal fun PaymentsScreen(s:UiState,m:BuriController,onExport:()->Unit){
    val t=LocalUiText.current
    val statement=s.isMemberStatement
    LazyColumn(Modifier.fillMaxSize(),state=routeList(s,m),contentPadding=PaddingValues(20.dp,4.dp,20.dp,26.dp)){
        if(statement)s.member?.takeIf{it.id==s.routeId}?.let{member->
            item(key="statement-member"){
                Row(Modifier.fillMaxWidth().padding(top=8.dp,bottom=18.dp).semantics(mergeDescendants=true){},
                    verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){
                    Avatar(member.name,size=48)
                    Column(Modifier.weight(1f)){
                        Text(member.name,style=MaterialTheme.typography.titleLarge,modifier=Modifier.semantics{heading()})
                        CompactLabel(member.phone,style=MaterialTheme.typography.bodyMedium,color=BuriTheme.Muted)
                    }
                }
            }
        }
        item{Search(s.search,m::search,m::searchSubmit,if(statement)"Search transactions" else "Name or payment reference",s.busy)}
        item{ListingToolbar(m,onExport,showFilter=statement,showExport=!statement)}
        if(!statement)item{ScrollingChips(Modifier.padding(vertical=12.dp),spacing=10.dp){chip ->
            FilterChipIcon(t("All"),R.drawable.ic_activity,s.filter=="all",modifier=chip){m.setFilter("all")}
            FilterChipIcon(t("Allocated"),R.drawable.ic_link,s.filter=="allocated",modifier=chip){m.setFilter("allocated")}
            val count=s.home?.unallocatedCount?:if(s.filter=="unallocated"&&s.search.isBlank())s.payments?.totalCount else null
            FilterChipIcon(t("Unallocated"),R.drawable.ic_unlinked,s.filter=="unallocated",count,modifier=chip){m.setFilter("unallocated")}
        }}
        item{
            val count=s.payments?.totalCount
            val label=when{
                count==null->""
                !statement->count.toString()
                count==1->t("1 transaction")
                else->t("%1\$d transactions",count)
            }
            CountLine(label,"RWF")
        }
        val payments=s.payments?.items.orEmpty()
        itemsIndexed(payments,key={_,p->p.id}){index,p->
            val memberId=if(statement)null else PaymentPresentation.linkedMemberId(p)
            PaymentRow(p,index==0,index==payments.lastIndex,statement=statement,opensStatement=memberId!=null){
                if(memberId!=null)m.navigate(Route.PAYMENTS,memberId) else m.navigate(Route.PAYMENT,p.id)
            }
        }
        if(s.payments?.items?.isEmpty()==true)item{
            Empty(t(if(statement)"No transactions" else "No payments"))
        }
        moreButton(s.payments?.nextCursor,s.busy,m::more,autoEnabled=!s.offline&&s.error==null,paging=m.operation==UiOperation.LOAD_MORE)
    }
}
@Composable internal fun PaymentScreen(s:UiState,m:BuriController){
    val t=LocalUiText.current
    val p=s.payment
    if(p==null){if(s.busy)BuriLoadingPanel("Loading payment",Route.PAYMENT)else Empty(t("Payment unavailable. Go back or refresh."));return}
    val status=PaymentPresentation.payment(p)
    val canAllocate=PaymentPresentation.canAllocate(p)&&m.allows(Capability.ALLOCATE)
    Box(Modifier.fillMaxSize()){
        LazyColumn(Modifier.fillMaxSize().testTag("payment-details-scroll"),state=routeList(s,m),contentPadding=PaddingValues(20.dp,20.dp,20.dp,if(canAllocate)104.dp else 26.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
            item{Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.Center){
                Box(Modifier.size(78.dp).background(stateTone(status.tone).copy(alpha=.08f),CircleShape),contentAlignment=Alignment.Center){Glyph(stateIcon(status.icon),null,stateTone(status.tone),36)}
            }}
            item{SingleLineName(p.payerNameRaw.ifBlank{t("Unavailable")},Modifier.fillMaxWidth(),26,TextAlign.Center)}
            item{BigValue(p.amountRwf)}
            item{CompactLabel(t(status.label),Modifier.fillMaxWidth(),color=stateTone(status.tone),fontSize=14.sp,lineHeight=21.sp,textAlign=TextAlign.Center)}
            item{FactGroup(buildList{
                add(t("Direction") to t(PaymentPresentation.directionLabel(p.direction)))
                p.paymentReference?.let{add(t("Payment reference") to it)}
                p.ftId?.let{add(t("FT Id") to it)}
                add(t("Provider time") to historyTime(p.atRaw,t.locale).ifBlank{t("Unavailable")})
                add((if(p.memberPhone!=null&&p.memberPhone!=p.payerPhoneRaw)t("Member MoMo")else t("MoMo")) to (p.memberPhone?:p.payerPhoneRaw.ifBlank{t("Unavailable")}))
                if(p.memberPhone!=null&&p.memberPhone!=p.payerPhoneRaw)add(t(if(p.direction=="outgoing")"Recipient" else "from") to "${p.payerNameRaw} (${p.payerPhoneRaw})")
                p.feeRwf?.let{add(t("Fee") to t("RWF %1\$s",money(it,t.locale)))}
            },compactValueLabels=setOf(t("Recipient"),t("from")))}
            p.sourceId?.takeIf{m.allows(Capability.SMS)}?.let{sourceId->
                item{Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.Center){RoundAction(R.drawable.ic_sms,t("Original SMS"),{
                    m.openSms(if(p.sourceKind=="observation")SmsSourceRef.Observation(sourceId) else SmsSourceRef.Canonical(sourceId))
                },!s.busy,58)}}
            }
        }
        if(canAllocate)Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal=20.dp).padding(bottom=13.dp)){
            Primary(t("Allocate"),{m.openSheet(Sheet.ALLOCATE)},!s.busy&&!s.offline&&!s.pending,icon=R.drawable.ic_link,modifier=Modifier.testTag("payment-allocation-fixed"))
        }
    }
}
@Composable internal fun MembersScreen(s:UiState,m:BuriController,onExport:()->Unit){
    val t=LocalUiText.current
    LazyColumn(Modifier.fillMaxSize(),state=routeList(s,m),contentPadding=PaddingValues(20.dp,4.dp,20.dp,26.dp)){
        item{Search(s.search,m::search,m::searchSubmit,"Name or MoMo number",s.busy)}
        item{ListingToolbar(m,onExport)}
        item{CompactLabel(s.members?.totalCount?.let{if(it==1)t("1 member")else t("%1\$d members",it)}?:t("Unavailable"),color=BuriTheme.Muted)}
        val members=s.members?.items.orEmpty()
        itemsIndexed(members,key={_,member->member.id}){index,member->MemberRow(member,index==0,index==members.lastIndex){m.openMember(member)}}
        if(s.members?.items?.isEmpty()==true)item{
            Empty(t("No members"))
            if(s.search.isNotBlank())Text(t("Try a name or MoMo number."),color=BuriTheme.Muted)
        }
        moreButton(s.members?.nextCursor,s.busy,m::more,autoEnabled=!s.offline&&s.error==null,paging=m.operation==UiOperation.LOAD_MORE)
    }
}
@Composable internal fun MemberScreen(s:UiState,m:BuriController){
    val t=LocalUiText.current
    val member=s.member
    if(member==null){if(s.busy)BuriLoadingPanel("Loading member",Route.MEMBER)else Empty(t("Member unavailable. Go back or refresh."));return}
    LazyColumn(Modifier.fillMaxSize(),state=routeList(s,m),contentPadding=PaddingValues(20.dp,20.dp,20.dp,26.dp),verticalArrangement=Arrangement.spacedBy(14.dp)){
        item{Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.Center){Avatar(member.name,66,initialsSize=24)}}
        item{SingleLineName(member.name,Modifier.fillMaxWidth(),32,TextAlign.Center);Spacer(Modifier.height(8.dp));CompactLabel(if(member.active)member.phone else t("%1\$s · %2\$s",member.phone,t("Inactive")),Modifier.fillMaxWidth(),fontSize=14.sp,color=BuriTheme.Muted,lineHeight=21.sp,textAlign=TextAlign.Center)}
        item{Primary(t("View payments"),{m.navigate(Route.PAYMENTS,member.id)},!s.busy,icon=R.drawable.ic_activity)}
        item{Primary(t("Member details"),{m.openSheet(Sheet.MEMBER_DETAILS)},!s.busy,secondary=true,icon=R.drawable.ic_info)}
    }
}
