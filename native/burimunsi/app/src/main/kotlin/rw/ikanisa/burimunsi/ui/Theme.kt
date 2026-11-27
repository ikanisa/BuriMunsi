package rw.ikanisa.burimunsi.ui

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import rw.ikanisa.burimunsi.core.Route

/** BuriMunsi adaptation of revolut-design@jean-bosco-skills Dark/Glow references.
 * These local rendering values are provisional adapters, not exported native tokens.
 * Preserve the product's identity and task routes; see the integration review.
 */
internal data class BuriRouteColors(val muted:Color,val blue:Color,val tone:Color,val group:Color)
internal val LocalBuriRoute=staticCompositionLocalOf{Route.LOGIN}
internal val LocalBuriRouteColors=staticCompositionLocalOf{BuriRouteColors(Color(0xFFA1A1A3),Color(0xFF8CA2FF),Color(0xFF232326),Color(0xFF161618))}
object BuriTheme {
    val Canvas=Color(0xFF000000);val Surface=Color(0xFF161618);val Raised=Color(0xFF232326)
    val Text=Color(0xFFF4F4F4)
    val NavigationSurface=Color(0xF20C0D17);val NavigationSelected=Color(0xFF24242E);val NavigationMuted=Color(0xFFA1A1A3)
    val NavigationOutline=Color(0xFF3B3B49)
    val HeaderActionSurface=Color(0xDD0C0D18)
    val Input:Color @Composable get()=if(LocalBuriRoute.current==Route.LOGIN)Color.Black.copy(alpha=.23f)else Color(0xFF28282B)
    val Muted:Color @Composable get()=LocalBuriRouteColors.current.muted
    val Blue:Color @Composable get()=LocalBuriRouteColors.current.blue
    val Tone:Color @Composable get()=LocalBuriRouteColors.current.tone
    val Group:Color @Composable get()=LocalBuriRouteColors.current.group
    val Good=Color(0xFF52DAB1);val Warn=Color(0xFFFFD190);val Bad=Color(0xFFFF8C9A)
    // Route washes preserve the selected visual family for each BuriMunsi workflow.
    const val WashScrimAlpha=0f
    internal fun colors(route:Route)=when(route){
        Route.HOME->BuriRouteColors(Color(0xFFC5D3FA),Color(0xFFD9E5FF),Color(0x2E9DBCFF),Color(0x215A84ED))
        Route.PAYMENTS->BuriRouteColors(Color(0xFFD3C5E7),Color(0xFFE1D1FF),Color(0x29D0ABFF),Color(0x219B6DC8))
        Route.MEMBERS->BuriRouteColors(Color(0xFFBEDBDC),Color(0xFFC0F0EF),Color(0x2B9DE2E2),Color(0x2643979C))
        Route.SMS->BuriRouteColors(Color(0xFFCBD1E7),Color(0xFFD6DFFF),Color(0x2BB0BEEE),Color(0x1F7D90CF))
        Route.LOGIN->BuriRouteColors(Color(0xFFC2CEE8),Color(0xFF8CA2FF),Color(0x2191A9E5),Surface)
        else->BuriRouteColors(Color(0xFFA1A1A3),Color(0xFF8CA2FF),Raised,Surface)
    }
    private fun type(size:Int,line:Int,weight:FontWeight=FontWeight.Normal)=TextStyle(
        fontFamily=FontFamily.SansSerif,fontWeight=weight,fontSize=size.sp,lineHeight=line.sp)
    val Typography=Typography(
        displayLarge=type(64,72,FontWeight.Medium),displayMedium=type(48,56,FontWeight.Medium),displaySmall=type(40,48,FontWeight.SemiBold),
        headlineLarge=type(32,40,FontWeight.SemiBold),headlineMedium=type(28,36,FontWeight.SemiBold),headlineSmall=type(24,32,FontWeight.SemiBold),
        titleLarge=type(22,30,FontWeight.Medium),titleMedium=type(19,27,FontWeight.Medium),titleSmall=type(17,25,FontWeight.Medium),
        bodyLarge=type(17,26),bodyMedium=type(16,24),bodySmall=type(14,21),
        labelLarge=type(18,26,FontWeight.SemiBold),labelMedium=type(14,21,FontWeight.Medium),labelSmall=type(14,21))
    // Vertical approximations of unobstructed, ICC-normalized Dark · Glow phone-canvas samples.
    // Home LIVE-020, Members LIVE-021, Payments LIVE-051, SMS LIVE-025 and sign-in LIVE-002.
    private val neutralWash=Brush.verticalGradient(listOf(Canvas,Canvas))
    private val routeWashes=mapOf(
        Route.HOME to Brush.verticalGradient(
            0f to Color(0xFF5B83FC),.10f to Color(0xFF3D5EFB),.23f to Color(0xFF1425D2),
            .43f to Color(0xFF050B76),.55f to Color(0xFF000447),.70f to Color(0xFF05074D),
            .85f to Color(0xFF010440),1f to Color(0xFF010337)),
        Route.MEMBERS to Brush.verticalGradient(
            0f to Color(0xFF32A1B6),.10f to Color(0xFF22788E),.23f to Color(0xFF0F4254),
            .43f to Color(0xFF0A2936),.55f to Color(0xFF051C24),1f to Color(0xFF02171D)),
        Route.PAYMENTS to Brush.verticalGradient(
            0f to Color(0xFF6C3CDE),.07f to Color(0xFF3D2480),.10f to Color(0xFF2D1C5D),
            .16f to Color(0xFF1B1239),.32f to Color(0xFF17133B),1f to Color(0xFF16153A)),
        Route.SMS to Brush.verticalGradient(
            0f to Color(0xFF6373C2),.10f to Color(0xFF48569B),.23f to Color(0xFF27346E),
            .43f to Color(0xFF182454),.55f to Color(0xFF121637),1f to Color(0xFF0E142D)),
        Route.LOGIN to Brush.verticalGradient(
            0f to Color(0xFF32448F),.16f to Color(0xFF1D2A87),.32f to Color(0xFF121B6D),
            .55f to Color(0xFF0D164C),.70f to Color(0xFF101240),1f to Color(0xFF11103A)),
    )
    fun wash(route:Route):Brush = routeWashes[route] ?: neutralWash
}
/** Tests can fix motion without changing the installation preference. */
@Composable fun BuriContent(reduceMotion:Boolean?=null,content:@Composable ()->Unit) {
    UiPreferencesProvider(reduceMotion) {
        BuriMotionProvider {
        MaterialTheme(colorScheme=darkColorScheme(
            primary=BuriTheme.Text,onPrimary=Color(0xFF151517),secondary=BuriTheme.Blue,
            background=BuriTheme.Canvas,surface=BuriTheme.Surface,onSurface=BuriTheme.Text,
            onSurfaceVariant=BuriTheme.Muted,error=BuriTheme.Bad,onBackground=BuriTheme.Text),
            typography=BuriTheme.Typography) {
            Surface(Modifier.fillMaxSize(),color=BuriTheme.Canvas,contentColor=BuriTheme.Text,content=content)
        }
        }
    }
}
