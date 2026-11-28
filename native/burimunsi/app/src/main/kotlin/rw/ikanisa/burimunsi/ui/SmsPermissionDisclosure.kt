package rw.ikanisa.burimunsi.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import app.cool.mobile.R

/** Presentation only. MainActivity owns role/session validation and the OS request. */
@Composable
internal fun SmsPermissionDisclosure(onContinue: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("sms-permission-notice"),
        containerColor = BuriTheme.Surface,
        text = {
            Column(Modifier.testTag("sms-permission-copy").verticalScroll(rememberScrollState())) {
                Text(
                    stringResource(R.string.buri_sms_notice_title),
                    color = BuriTheme.Text,
                    style = androidx.compose.material3.MaterialTheme.typography.titleLarge,
                )
                Text(stringResource(R.string.buri_sms_notice_body), color = BuriTheme.Text)
            }
        },
        confirmButton = {
            TextButton(onClick = onContinue) {
                Text(stringResource(R.string.buri_sms_notice_continue), color = BuriTheme.Blue)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.buri_sms_notice_cancel), color = BuriTheme.Muted)
            }
        },
    )
}
