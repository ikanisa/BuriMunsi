package rw.ikanisa.burimunsi

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

class RolePackageTrustTest {
    @Test fun releaseTrustIsBoundToTheExactPackageAndCertificateLineage() {
        val staff = BuriRolePackages.STAFF
        val admin = BuriRolePackages.ADMIN
        val playStaff = "0a52db15104416597082b6057c10f0fca154ab9bfec70e9fd2fd442bbd2cb77a"
        val playAdmin = "9346eab67afe7eb25fac3b30c0a8680cf1b4090636d141cbec57d526037080b7"
        val direct = "a9003fa58bf2be62b61fc1f1d76a7691bbb0f18a3c43f60b81785bbe990e2b51"
        assertTrue(BuriRolePackages.acceptsReleaseDigest(staff, playStaff))
        assertTrue(BuriRolePackages.acceptsReleaseDigest(admin, playAdmin))
        assertTrue(BuriRolePackages.acceptsReleaseDigest(staff, direct))
        assertTrue(BuriRolePackages.acceptsReleaseDigest(admin, direct))
        assertFalse(BuriRolePackages.acceptsReleaseDigest(admin, playStaff))
        assertFalse(BuriRolePackages.acceptsReleaseDigest(staff, playAdmin))
        assertFalse(BuriRolePackages.acceptsReleaseDigest(staff, "0".repeat(64)))
        assertFalse(BuriRolePackages.acceptsReleaseDigest(admin + ".debug", direct))
        assertNull(BuriRolePackages.adminForStaff(staff + ".other"))
        assertNull(BuriRolePackages.staffForAdmin(admin + "suffix"))
    }

    @Test fun crossFlavorAndMissingPackagesNeverQualify() {
        val pm = InstrumentationRegistry.getInstrumentation().targetContext.packageManager
        assertNull(BuriRolePackages.verifiedPair(pm, BuriRolePackages.STAFF, BuriRolePackages.ADMIN + ".nativeTest"))
        assertNull(BuriRolePackages.verifiedPair(pm, "missing.staff", "missing.admin"))
    }
}
