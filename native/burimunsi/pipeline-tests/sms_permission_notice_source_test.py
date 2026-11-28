"""Source contract for the release-only SMS prompt; UI tests are a separate gate."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

NATIVE = Path(__file__).resolve().parents[1]
MAIN = NATIVE / "app/src/main"
ACTIVITY = (MAIN / "kotlin/rw/ikanisa/burimunsi/MainActivity.kt").read_text()
RECEIVER = (MAIN / "kotlin/rw/ikanisa/burimunsi/ui/NativeReceiverStatus.kt").read_text()
RES = MAIN / "res/values/sms_permission_notice.xml"

class SmsPermissionDisclosure(unittest.TestCase):
    def test_only_continue_action_launches_the_os_sms_prompt(self):
        offer, continuation = ACTIVITY.split("private fun offerReceivingPermissions(", 1)[1].split(
            "private fun continueReceivingPermissions(", 1)
        self.assertIn("smsPermissionNotice = SmsPermissionNotice", offer)
        self.assertNotIn("permissions.launch", offer)
        continuation = continuation.split("private val notifications=", 1)[0]
        self.assertIn("smsPermissionNotice !== notice", continuation)
        self.assertIn("notice.offer.confirm", continuation)
        self.assertIn("permissions.launch(missing.toTypedArray())", continuation)
        self.assertEqual(ACTIVITY.count("permissions.launch("), 1)
        self.assertIn("onContinue = { continueReceivingPermissions(notice) }", ACTIVITY)

    def test_role_and_foreground_are_rechecked_and_pause_discards_notice(self):
        guard = ACTIVITY.split("private fun currentSmsOwner(", 1)[1].split("private fun offerReceivingPermissions(", 1)[0]
        for condition in ("BuildConfig.IS_GATEWAY", "smsVisible", "smsForeground == foreground",
                          "ScreenGate.OPEN", "it.id == actorId", "it.role == Role.ADMIN"):
            self.assertIn(condition, guard)
        pause = ACTIVITY.split("onPauseOrDispose {", 1)[1].split("stopNetworkObservation()", 1)[0]
        for action in ("smsVisible=false", "smsForeground++", "smsPermissionNotice=null"):
            self.assertIn(action, pause)

    def test_async_confirmation_reuses_the_original_ticket_and_bounds_permissions(self):
        prepare = RECEIVER.split("fun preparePermissions(", 1)[1].split("private suspend fun receivingPermissions", 1)[0]
        self.assertEqual(prepare.count("request()"), 1)
        self.assertIn("PermissionOffer(names, { current(ticket) })", prepare)
        self.assertIn("names.containsAll(latest)", prepare)
        self.assertIn("current(ticket) { dispatch(latest) }", prepare)

    def test_disclosure_covers_data_destination_purpose_and_decline(self):
        translations = {s.attrib["name"]: s.text for s in ET.parse(RES).getroot()}
        body = translations["buri_sms_notice_body"]
        for term in ("not open", "Phone permission", "active SIM", "receipt text", "phone numbers", "Supabase",
                     "record and reconcile payments", "security codes", "Not now"):
            self.assertIn(term, body)
        self.assertEqual(translations["buri_sms_notice_cancel"], "Not now")
        self.assertIn("onDismiss = { smsPermissionNotice = null }", ACTIVITY)

if __name__ == "__main__":
    unittest.main()
