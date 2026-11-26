package rw.ikanisa.burimunsi.ui

import android.content.Context
import android.content.res.Configuration
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import java.util.Locale

private val appLocale = Locale.forLanguageTag("en-RW")

/** Presentation copy only. Never apply this to evidence, personal names or identifiers. */
internal class UiText(private val context:Context,val locale:Locale) {
    operator fun invoke(english:String,vararg arguments:Any):String {
        val id=UiStringIds[english]
        return if(id!=null) {
            if(arguments.isEmpty())context.getString(id) else context.getString(id,*arguments)
        } else {
            // Unknown service messages remain unchanged. No heuristic translation of records.
            if(arguments.isEmpty())english else String.format(locale,english,*arguments)
        }
    }
}
internal data class UiPreferences(
    val reduceMotion:Boolean,
    val setReduceMotion:(Boolean)->Unit,
)
internal val LocalUiText=staticCompositionLocalOf<UiText>{error("BuriContent is required")}
internal val LocalUiPreferences=staticCompositionLocalOf<UiPreferences>{error("BuriContent is required")}

/** Stores only display preferences. No operator, session, receipt, form or credential data. */
@Composable internal fun UiPreferencesProvider(reduceMotion:Boolean?,content:@Composable ()->Unit){
    val context=LocalContext.current
    val configuration=LocalConfiguration.current
    val settings=remember(context){context.applicationContext.getSharedPreferences("buri-display",Context.MODE_PRIVATE)}
    var reduced by remember(settings){mutableStateOf(settings.getBoolean("reduce-screen-motion",false))}
    LaunchedEffect(settings) {
        if (settings.contains("language")) settings.edit().remove("language").apply()
    }
    val englishContext = remember(context, configuration) {
        context.createConfigurationContext(Configuration(configuration).apply { setLocale(appLocale) })
    }
    val text = remember(englishContext) { UiText(englishContext, appLocale) }
    val preferences=UiPreferences(reduceMotion?:reduced,
        setReduceMotion={value->reduced=value;settings.edit().putBoolean("reduce-screen-motion",value).apply()})
    CompositionLocalProvider(
        LocalUiText provides text,
        LocalUiPreferences provides preferences,
        LocalConfiguration provides englishContext.resources.configuration,
        LocalResources provides englishContext.resources,
        LocalLayoutDirection provides LayoutDirection.Ltr,
        content=content,
    )
}

@Composable internal fun UiPreferencePanel(){
    val t=LocalUiText.current
    val preferences=LocalUiPreferences.current
    Column(Modifier.fillMaxWidth().padding(vertical=16.dp)){
        Row(Modifier.fillMaxWidth().heightIn(min=56.dp).toggleable(value=preferences.reduceMotion,
            role=Role.Switch,onValueChange=preferences.setReduceMotion),verticalAlignment=Alignment.CenterVertically){
            CompactLabel(t("Reduce screen motion"),Modifier.weight(1f));Spacer(Modifier.width(12.dp))
            Switch(preferences.reduceMotion,onCheckedChange=null)
        }
        Text(t("Reduce screen transitions and loading motion. Android controls keyboard and dialog animations."),
            style=MaterialTheme.typography.bodySmall,color=BuriTheme.Muted)
    }
}
