package rw.ikanisa.burimunsi

import android.app.Application
import android.app.LocaleManager
import android.os.Build
import android.os.LocaleList
import rw.ikanisa.burimunsi.gateway.GatewayFactory
import java.util.Locale

class BuriApplication : Application() {
    override fun onCreate(){
        super.onCreate()
        // Android can restore an app language selected before the English-only update.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getSystemService(LocaleManager::class.java)?.let { manager ->
                val previous = manager.applicationLocales
                val english = LocaleList(Locale.ENGLISH)
                if (!previous.isEmpty && previous != english) manager.applicationLocales = english
            }
        }
        // Flavor dispatch is a no-op on Staff. Android remains the authority on
        // whether a foreground service may start from this process entry point.
        runCatching{GatewayFactory.create(this).recoverContinuous()}
    }
}
