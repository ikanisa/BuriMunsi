package rw.ikanisa.burimunsi.core

import java.time.Instant
import java.util.Locale

/** Sender-scoped, credential-filtered inbox intake. Transaction classification
 * happens on the backend; incoming-only markers must not suppress other MoMo messages. */
object ObservationCandidate {
    private val senderControls=Regex("[\\u0000-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]")
    // Preserve ordinary multiline SMS text without accepting hidden controls.
    private val bodyControls=Regex("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]")
    // Keep this filter narrow enough to retain unfamiliar financial formats. Generic
    // transaction/reference codes are not credentials, and a complete number-free
    // PIN safety warning does not invalidate an otherwise eligible receipt.
    private val credential = Regex(
        """(?<![\p{L}\p{N}_])(?:otp|one[ -]?time(?:[ -]?(?:password|passcode|code))?|password|passcode|(?:verification|activation|security|login|authori[sz]ation)[ -]code|(?:your|the|this|enter|use)\s+code\b|mot\s+de\s+passe|code\s+(?:de\s+)?(?:v[eé]rification|confirmation|s[eé]curit[eé]|activation|connexion|secret)|(?:kode|code)(?:\s+yawe)?\s+y['’]?ibanga|kode\s+(?:yo\s+kwemeza|yemeza)|ijambo\s+ry['’]?ibanga|umubare\s+(?:wawe\s+)?w['’]?ibanga|ijambobanga|pin(?:[ -]code)?)(?![\p{L}\p{N}_])""",
        RegexOption.IGNORE_CASE,
    )
    private val numberFreePinWarning = Regex(
        """^(?:(?:for your (?:security|safety)[,:]?\s*)?(?:please\s+)?(?:(?:never|do not|don't)\s+(?:share|disclose|reveal|give|tell)\b.*\bpin\b|keep\b.*\bpin\b.*\b(?:secret|safe|private)\b)|ne\s+(?:partagez|communiquez|divulguez|donnez)\s+jamais\s+(?:votre|le)\s+pin(?:\s+(?:[àa]\s+personne|avec\s+quiconque))?|ntugasangize\s+(?:undi(?:\s+muntu)?\s+)?pin\s+yawe|usimpe\s+mtu(?:\s+yeyote)?\s+pin\s+yako)[.!?;]?$""",
        RegexOption.IGNORE_CASE,
    )
    private val sentences = Regex("""(?<=[.!?;])\s+|[\r\n]+""")
    private val letters = Regex("""\p{L}""")
    private val numbers = Regex("""\p{N}""")
    fun hasCredentials(sender: String, body: String): Boolean {
        if (body.contains("code", ignoreCase = true)) {
            val aliases = setOf(sender, "M-Money", "M Money").joinToString("|") { Regex.escape(it) }
            val senderCode = Regex(
                """(?<![\p{L}\p{N}_])(?:(?:your|the|this|votre|le)\s+(?:${aliases})\s+code|(?:votre|le)\s+code\s+(?:${aliases}))(?![\p{L}\p{N}_])""",
                RegexOption.IGNORE_CASE,
            )
            if (senderCode.containsMatchIn(body)) return true
        }
        if (!credential.containsMatchIn(body)) return false
        val clauses = sentences.split(body)
        if (clauses.any { clause ->
                credential.containsMatchIn(clause) &&
                    (numbers.containsMatchIn(clause) || !numberFreePinWarning.matches(clause.trim()))
            }) return true
        // A PIN warning alone is not evidence. A bare code after a standalone
        // warning must not become eligible merely because each line is safe on its own.
        val remainder = clauses.filterNot(credential::containsMatchIn).joinToString(" ")
        return !letters.containsMatchIn(remainder) || remainder.none { it in '0'..'9' }
    }

    private val possibleFinancialLanguage = Regex(
        """(?<![\p{L}\p{N}_])(?:payment|paid|transfer(?:red)?|transaction|receipt|reversal|reversed|withdrawal|deposit|balance|amount|paiement|retrait|versement|virement|montant|solde|amafaranga|kwishyura|kwakira|yasubijwe)(?![\p{L}\p{N}_])""",
        RegexOption.IGNORE_CASE,
    )
    private fun validBody(body: String): Boolean =
        body.toByteArray(Charsets.UTF_8).size in 1..3000 && !bodyControls.containsMatchIn(body)

    private fun possiblyFinancial(body: String, profile: ReceiptProfile): Boolean =
        possibleFinancialLanguage.containsMatchIn(body) ||
            (profile.currencyAliases + profile.incomingPrefixes + profile.transactionIdPrefixes).any {
                it.isNotBlank() && body.contains(it, ignoreCase = true)
            }

    /** Known credential-only rows are outside the receipt census. A mixed
     * financial/credential row is withheld and remains unconfirmed. */
    fun excludeFromFinancialCensus(sender: String, body: String, profile: ReceiptProfile): Boolean =
        validBody(body) && hasCredentials(sender, body) && !possiblyFinancial(body, profile)

    enum class InboxDisposition { EXCLUDED, CANDIDATE, MIXED_CREDENTIALS }

    fun inboxDisposition(sender: String, body: String, profile: ReceiptProfile): InboxDisposition {
        if (!senderAllowed(sender, profile) || !validBody(body)) return InboxDisposition.EXCLUDED
        if (!hasCredentials(sender, body)) return InboxDisposition.CANDIDATE
        return if (possiblyFinancial(body, profile)) InboxDisposition.MIXED_CREDENTIALS else InboxDisposition.EXCLUDED
    }

    fun senderAllowed(sender:String,profile:ReceiptProfile):Boolean {
        if(profile.version.isBlank()||profile.version=="unverified"||profile.senders.isEmpty()||profile.senders.size>30||
            profile.senders.any{it.length>160||it.trim().isEmpty()||it.any{c->c=='\r'||c=='\n'||c=='\u0000'}})return false
        return sender.length in 1..96&&sender==sender.trim()&&!senderControls.containsMatchIn(sender)&&
            profile.senders.any{it.lowercase(Locale.ROOT)==sender.lowercase(Locale.ROOT)}
    }
    fun accepts(sender:String,body:String,profile:ReceiptProfile):Boolean =
        senderAllowed(sender,profile)&&validBody(body)&&!hasCredentials(sender,body)
}

/** A candidate receipt is evidence only: it does not identify a wallet or a ledger credit. */
data class ObservationProfile(val receipt:ReceiptProfile, val issuedAt:Long, val expiresAt:Long, val legacyHold:Boolean?=null) {
    fun current(now:Long):Boolean = now>0 && issuedAt>0 && issuedAt<=now+300_000 && expiresAt>now &&
        expiresAt>issuedAt && expiresAt-issuedAt<=24L*60*60*1000 && receipt.version.isNotBlank() &&
        receipt.version!="unverified" && receipt.offsetMinutes in -840..840
    fun fingerprint():String {
        val parts=listOf(receipt.version,receipt.offsetMinutes.toString())+
            listOf(receipt.senders,receipt.incomingPrefixes,receipt.currencyAliases,receipt.transactionIdPrefixes)
                .flatMap{values->listOf(values.size.toString())+values.sorted()}
        return Values.sha256(parts.joinToString(""){"${it.length}:$it"})
    }
}

/** These values are retained with a single request ID and resent without alteration. */
data class SmsObservation(
    val requestId:String,
    val rawSender:String,
    val rawBody:String,
    val sourceMode:String,
    val complete:Boolean,
    val capturedAt:String,
    val serviceCentreAt:String?,
    val inboxReceivedAt:String?,
    val subscriptionId:Int?,
    val sourceKey:String?=null,
) {
    override fun toString()="SmsObservation(redacted)"
    fun valid(profile:ObservationProfile, now:Long):Boolean {
        if(!profile.current(now) || runCatching{Values.requestId(requestId)==requestId}.getOrDefault(false).not())return false
        if(rawSender.length !in 1..96 || rawSender!=rawSender.trim() || rawBody.toByteArray(Charsets.UTF_8).size !in 1..3000 ||
            !((sourceMode=="live"&&complete)||(sourceMode=="catch_up"&&!complete&&inboxReceivedAt!=null)) ||
            subscriptionId!=null&&subscriptionId<0 || sourceKey!=null&&
                (sourceMode!="catch_up"||!Regex("[a-f0-9]{64}").matches(sourceKey)))return false
        fun timestamp(value:String?)=value==null||Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z").matches(value)&&
            runCatching{Instant.parse(value);true}.getOrDefault(false)
        if(!timestamp(capturedAt)||!timestamp(serviceCentreAt)||!timestamp(inboxReceivedAt))return false
        return ObservationCandidate.accepts(rawSender,rawBody,profile.receipt)
    }

    /** Local parsing is a display hint; the backend still owns financial authority. */
    fun unverifiedFacts(profile:ObservationProfile, now:Long):UnverifiedObservationFacts? {
        if(!valid(profile,now))return null
        val parsed=try{if(complete)ReceiptParser.parse(rawSender,rawBody,true,profile.receipt)
            else ReceiptParser.inboxTextHint(rawSender,rawBody,profile.receipt)}catch(_:ContractFailure){return null}
        return UnverifiedObservationFacts(parsed.amountRwf,parsed.payerNameRaw,parsed.payerPhoneRaw,parsed.atRaw,parsed.ftId,complete)
    }
}

data class UnverifiedObservationFacts(val amountRwf:Long,val payerName:String,val payerPhone:String,val receivedAt:String,val reference:String,val sourceComplete:Boolean) {
    override fun toString()="UnverifiedObservationFacts(redacted)"
}

data class ObservationAck(val requestId:String,val sourceId:String,val bodySha256:String,val status:String,val financialEffects:Int)

/** Metadata used to compare one phone inbox source with its retained Cloud source. */
data class ObservationReconcileRequest(
    val sourceKey:String,val bodySha256:String,val rawSender:String,val serviceCentreAt:String?,
    val inboxReceivedAt:String,val subscriptionId:Int?,val gatewayEnvelopeId:String?=null,
) {
    override fun toString()="ObservationReconcileRequest(redacted)"
}

data class ObservationReconcileReply(val sourceKey:String,val state:String,val sourceId:String?,val latestRecordedSourceId:String?,val processingStatus:String?=null) {
    override fun toString()="ObservationReconcileReply(redacted)"
}
data class ObservationReconcileStatus(val hasPending:Boolean,val hasRecorded:Boolean,val recordedCount:Int,val revision:String,
    val hasUnmatchedCanonical:Boolean)

/** Queue removal requires the server's durable unresolved-source acknowledgment. */
object ObservationAcknowledgement {
    fun matches(observation:SmsObservation, ack:ObservationAck):Boolean =
        ack.requestId==observation.requestId && runCatching{Values.id(ack.sourceId);true}.getOrDefault(false) &&
        ack.bodySha256==Values.sha256(observation.rawBody) && ack.status=="source_unresolved" && ack.financialEffects==0
}

/** One scoped handset sweep. Checkpoints carry only counts and opaque source identities. */
data class ObservationInboxCheck(
    val runId: String, val expectedConsentGeneration: Long, val state: String,
    val candidateCount: Int = 0, val missingCount: Int = 0, val pendingCount: Int = 0,
    val phoneLatestKey: String? = null, val parsedLatestKey: String? = null, val collectionRevision: String? = null,
) {
    override fun toString() = "ObservationInboxCheck(state=$state)"
}
