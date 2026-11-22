package rw.ikanisa.burimunsi.storage
import android.app.Application
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object InstallationFixture {
 @Volatile var entered:CountDownLatch?=null
 @Volatile var release:CountDownLatch?=null
}
class DeviceProvisioning(app:Application,id:String){
 init {
  InstallationFixture.entered?.countDown()
  check(InstallationFixture.release?.await(5,TimeUnit.SECONDS)!=false)
 }
 val installationId=id
 fun token():String?=null
 fun registrationToken()="fixture-registration-token"
}

// Isolated store: no disk, keychain or prior-session state in controller fixtures.
class AndroidNavigationCheckpointStore(app:Application):rw.ikanisa.burimunsi.core.NavigationCheckpointStore {
 private var value:String?=null
 override fun read()=value
 override fun write(value:String){this.value=value}
 override fun clear(){value=null}
}
