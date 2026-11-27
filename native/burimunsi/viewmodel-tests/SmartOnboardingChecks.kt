package rw.ikanisa.burimunsi.smartonboardingtests

import android.app.Application
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.data.Fixture
import rw.ikanisa.burimunsi.data.ApiFailure
import rw.ikanisa.burimunsi.ui.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real ViewModel with synthetic repository and lifecycle boundaries. */
fun main() = runBlocking {
 val model = BuriViewModel(Application())
 // Android delivers every lifecycle and picker callback on the same dispatcher as ViewModel work.
 withContext(model.viewModelScope.coroutineContext.minusKey(Job)) {
  verifyOnboarding(model)
 }
}

private suspend fun BuriViewModel.awaitIdle() = withTimeout(10_000) {
 while (state.starting || state.busy) delay(2)
}

private suspend fun verifySuggestions(model:BuriViewModel,ck:(String,Boolean)->Unit){
 val a="7b5db134-bb63-4e7d-8cc0-6c62c7613ddd"
 val b="d9e5abcf-8f53-4cd3-8ace-61d73831cf24"
 fun page(group:String,ids:List<String>,next:String?=null):JSONObject {
  val rows=JSONArray()
  ids.forEach{rows.put(JSONObject().put("id",it).put("candidateId",it).put("groupId",group)
   .put("momoName",if(it==a)"Alice" else "Beata").put("last3",if(it==a)"123" else "678")
   .put("latestSeenAt","2026-11-01T12:00:00Z").put("sourceCount",1))}
  return JSONObject().put("items",rows).put("nextCursor",next).put("revision","current")
 }
 suspend fun settled()=withTimeout(5_000){while(model.state.onboarding.suggestionsLoading)delay(3)}
 suspend fun entered(latch:CountDownLatch)=withContext(Dispatchers.IO){check(latch.await(5,TimeUnit.SECONDS))}
 val queries=CopyOnWriteArrayList<String>()
 val initial=CountDownLatch(1);val releaseInitial=CountDownLatch(1)
 val nextPage=CountDownLatch(1);val releasePage=CountDownLatch(1)
 try {
  Fixture.suggestionRead={q,cursor,scope->
   queries.add(q)
   if(q.isEmpty()){initial.countDown();check(releaseInitial.await(5,TimeUnit.SECONDS))}
   if(cursor!=null){nextPage.countDown();check(releasePage.await(5,TimeUnit.SECONDS))}
   page(scope.collectionId,if(q.isEmpty()||cursor!=null)listOf(b)else listOf(a),if(q.isNotEmpty()&&cursor==null)"more" else null)
  }
  model.onboardingSuggestions()
  ck("opening suggested payers immediately loads all without reporting an empty list",model.state.onboarding.let{it.suggestionsLoading&&!it.suggestionsLoaded&&it.query.isEmpty()}&&!model.state.busy)
  entered(initial)
  model.onboardingSearchQuery("A");model.onboardingSearchQuery("Al");model.onboardingSearchQuery("Alice")
  settled()
  ck("rapid typing sends only its final query and publishes that payer",queries==listOf("","Alice")&&model.state.onboarding.suggestions.map{it.candidateId}==listOf(a))
  releaseInitial.countDown();delay(20)
  ck("an earlier unfiltered response cannot replace a newer search",model.state.onboarding.query=="Alice"&&model.state.onboarding.suggestions.single().candidateId==a)
  model.onboardingSuggestions("Alice","more");entered(nextPage)
  model.onboardingChoose(a)
  releasePage.countDown();delay(20)
  ck("choosing a payer cancels pagination and starts verification with only the suggested name",model.state.onboarding.let{
   it.step==SmartOnboardingStep.MEMBER&&it.candidate?.candidateId==a&&!it.verifiedOwnership&&!it.acceptedTerms&&!it.consentRecorded}&&model.state.draft==mapOf("name" to "Alice"))
  model.onboardingSuggestions(model.state.onboarding.query);settled()
  ck("returning from verification freshly reads the same search and discards candidate consents",model.state.onboarding.let{
   it.step==SmartOnboardingStep.SUGGESTIONS&&it.query=="Alice"&&it.candidate==null&&it.suggestions.single().candidateId==a}&&model.state.draft.isEmpty())
  Fixture.suggestionRead={_,_,_->throw ApiFailure("connection_unavailable",0)}
  model.onboardingSearchQuery("123");settled()
  ck("failed search never reports a confirmed empty result",model.state.onboarding.let{it.suggestionsFailed&&!it.suggestionsLoaded&&!it.suggestionsLoading&&it.suggestions.isEmpty()})
  Fixture.suggestionRead={q,_,scope->check(q=="123");page(scope.collectionId,emptyList())}
  model.onboardingSuggestions("123");settled()
  ck("retrying the current suffix can confirm a genuinely empty result",model.state.onboarding.let{it.suggestionsLoaded&&!it.suggestionsFailed&&it.suggestions.isEmpty()})
  Fixture.suggestionRead={_,_,_->page("an-unrelated-group",listOf(b))}
  model.onboardingSuggestions("123");settled()
  ck("suggestions from an unrelated group are rejected",model.state.onboarding.suggestionsFailed&&model.state.onboarding.suggestions.isEmpty())
  val closed=CountDownLatch(1);val finish=CountDownLatch(1)
  try{
   Fixture.suggestionRead={_,_,scope->closed.countDown();check(finish.await(5,TimeUnit.SECONDS));page(scope.collectionId,listOf(b))}
   model.onboardingSearchQuery("");entered(closed);model.onboardingOptions()
   finish.countDown();delay(20)
   ck("a response after Back cannot reopen the picker",model.state.onboarding==SmartOnboardingState())
  }finally{finish.countDown()}
  var firstPageReads=0
  Fixture.suggestionRead={q,cursor,scope->
   check(q.isEmpty())
   if(cursor==null){firstPageReads++;page(scope.collectionId,listOf(a),"more")}else page(scope.collectionId,listOf(b))
  }
  model.onboardingSuggestions();settled()
  ck("an empty query automatically presents the first eligible payer before any input",
   model.state.onboarding.let{it.suggestionsLoaded&&it.suggestions.single().candidateId==a&&it.nextCursor=="more"})
  model.onboardingSuggestions("","more");settled()
  ck("the continuation appends additional payers within the same query",model.state.onboarding.let{it.suggestions.map{c->c.candidateId}==listOf(a,b)&&it.nextCursor==null})
  model.onBackground()
  ck("backgrounding hides suggested payer identities",model.state.onboarding.suggestions.isEmpty())
  model.onForeground();model.awaitIdle();settled()
  ck("foreground revalidation reads the same collection from its first page",firstPageReads==2&&model.state.onboarding.suggestions.single().candidateId==a)
  model.onboardingChoose(a)
  try{
   Fixture.receiverGroupOverride="another-collection"
   model.onboardingSuggestions(model.state.onboarding.query)
   ck("the selected payer's search cannot reopen against a different collection",model.state.onboarding==SmartOnboardingState()&&firstPageReads==2)
  }finally{Fixture.receiverGroupOverride=null}
 }finally{
  releaseInitial.countDown();releasePage.countDown();Fixture.suggestionRead=null;model.onboardingOptions()
 }
}

private suspend fun verifyOnboarding(model: BuriViewModel) {
 var checks=0
 fun ck(label:String,value:Boolean){check(value){label};println("PASS $label");checks++}
 fun confirmEntry(displayedDraft:Map<String,String> = model.state.draft){
  model.onboardingConsent("ownership",true,displayedDraft);model.onboardingConsent("terms",true,displayedDraft);model.onboardingConsent("consent",true,displayedDraft)
 }
 fun confirmations()=model.state.onboarding.run{listOf(verifiedOwnership,acceptedTerms,consentRecorded)}
 fun startInput(view:BuriViewModel,kind:MemberInputKind)=checkNotNull(view.beginMemberInput(kind))
 fun result(view:BuriViewModel,id:String,uri:String?,mime:String?=null)=view.receiveMemberInput(id,uri,detectMime={mime})
 model.awaitIdle();model.onForeground();model.awaitIdle();model.openSheet(Sheet.ENROLL);model.awaitIdle()
 verifySuggestions(model,::ck)
 model.onboardingPhoto()
 val camera=startInput(model,MemberInputKind.CAMERA)
 model.onBackground();check(result(model,camera,"content://example/capture.jpg"))
 ck("captured photo waits for foreground revalidation",!model.state.onboarding.documentSelected&&model.currentMemberSelection(camera,true)==null)
 model.onForeground();model.awaitIdle()
 ck("the disclosed camera action binds consent to the captured image",model.state.onboarding.photoCaptureFlow&&model.state.onboarding.photoPreviewPending&&model.state.onboarding.ocrConsent&&model.state.onboarding.documentUri=="content://example/capture.jpg")
 ck("a different picker request cannot use the captured photo",model.currentMemberSelection("another-picker-request",true)==null)
 val capture=checkNotNull(model.currentMemberSelection(camera,true))
 val photoBytes="synthetic photo".toByteArray();model.previewMemberDocument(capture,"image/jpeg",photoBytes,true);model.awaitIdle()
 val repeated="already sent".toByteArray()
 model.previewMemberDocument(capture,"image/jpeg",repeated,true);model.awaitIdle()
 ck("consented capture is dispatched once and both input buffers are wiped",Fixture.onboardingPreviews==1&&Fixture.lastOnboardingConsent==true&&Fixture.lastOnboardingMimeType=="image/jpeg"&&photoBytes.all{it==0.toByte()}&&repeated.all{it==0.toByte()})
 model.onboardingOptions()
 model.onboardingPhoto();val canceled=startInput(model,MemberInputKind.CAMERA)
 model.onBackground();result(model,canceled,null);model.onForeground();model.awaitIdle()
 ck("cancelled camera returns to options without upload",model.state.onboarding.step==SmartOnboardingStep.OPTIONS&&!model.state.onboarding.photoPreviewPending&&Fixture.onboardingPreviews==1)
 model.onboardingImport();result(model,startInput(model,MemberInputKind.DOCUMENT),"content://example/manual-source.csv","text/csv");model.awaitIdle();model.onboardingManual()
 ck("manual entry from import discards the prior document and consent",model.state.onboarding.step==SmartOnboardingStep.MEMBER&&model.state.onboarding.documentUri==null&&!model.state.onboarding.ocrConsent&&model.state.onboarding.rows.isEmpty())
 model.onboardingImport();result(model,startInput(model,MemberInputKind.DOCUMENT),"content://example/suggestions-source.csv","text/csv");model.awaitIdle();model.onboardingSuggestions();model.awaitIdle()
 ck("suggestions from import discard the prior document and consent",model.state.onboarding.step==SmartOnboardingStep.SUGGESTIONS&&model.state.onboarding.documentUri==null&&!model.state.onboarding.ocrConsent&&model.state.onboarding.rows.isEmpty())
 model.onboardingImport();result(model,startInput(model,MemberInputKind.DOCUMENT),"content://example/photo-source.csv","text/csv");model.awaitIdle();model.onboardingPhoto()
 ck("camera from import starts a fresh capture without the prior document",model.state.onboarding.photoCaptureFlow&&model.state.onboarding.documentUri==null&&!model.state.onboarding.ocrConsent)
 result(model,startInput(model,MemberInputKind.CAMERA),null)
 model.onboardingImport()
 ck("import is part of the existing Add Member panel",model.state.sheet==Sheet.ENROLL&&model.state.onboarding.step==SmartOnboardingStep.IMPORT)
 val abandoned=startInput(model,MemberInputKind.DOCUMENT)
 model.closeSheet();model.openSheet(Sheet.ENROLL);model.awaitIdle();model.onboardingImport()
 val replacement=startInput(model,MemberInputKind.DOCUMENT)
 var metadataReads=0
 ck("an unbound legacy result is discarded without touching its provider",!model.receiveMemberInput(null,"content://example/unbound.csv",detectMime={metadataReads++;"text/csv"}))
 ck("same-operator reopen refuses an old result without touching its provider",!model.receiveMemberInput(abandoned,"content://example/old.csv",detectMime={metadataReads++;"text/csv"})&&metadataReads==0)
 model.onBackground();check(model.receiveMemberInput(replacement,"content://example/member.csv",detectMime={metadataReads++;"text/csv"}))
 ck("document picker result waits for fresh foreground authorization",!model.state.onboarding.documentSelected&&metadataReads==0)
 ck("duplicate Android callback is discarded",!result(model,replacement,"content://example/wrong.csv"))
 model.onForeground();model.awaitIdle()
 ck("authorized picker result survives background and resume without photo consent",metadataReads==1&&model.state.onboarding.documentSelected&&model.state.onboarding.documentUri=="content://example/member.csv"&&!model.state.onboarding.ocrConsent&&!model.state.onboarding.photoPreviewPending)
 val original=checkNotNull(model.currentMemberSelection(replacement,false))
 val cancelledReplacement=startInput(model,MemberInputKind.DOCUMENT)
 ck("opening a replacement picker prevents previously prepared document reads",
    runCatching{model.validateMemberDocumentRead(original)}.exceptionOrNull() is CancellationException)
 result(model,cancelledReplacement,null)
 ck("cancelling a replacement picker restores the original selection",model.currentMemberSelection(original.launchId,false)===original)
 val nextCsv=startInput(model,MemberInputKind.DOCUMENT)
 result(model,nextCsv,original.uri,"text/csv");model.awaitIdle()
 val csv=checkNotNull(model.currentMemberSelection(nextCsv,false))
 ck("choosing the same URI again invalidates the earlier selection",
    csv!==original&&runCatching{model.validateMemberDocumentRead(original)}.exceptionOrNull() is CancellationException)
 val bytes="synthetic csv".toByteArray();model.previewMemberDocument(csv,"text/csv",bytes,false);model.awaitIdle()
 ck("preview reads selected rows once and wipes input",Fixture.onboardingPreviews==2&&Fixture.lastOnboardingConsent==false&&bytes.all{it==0.toByte()}&&model.state.onboarding.rows.size==1)
 ck("successful preview drops the private source URI while retaining extracted rows",model.state.onboarding.documentUri==null&&!model.state.onboarding.documentSelected)
 model.onboardingEditRow(1);model.editDraft("phone","0780000001");confirmEntry()
 model.onboardingSaveRow("Example Member","0780000002")
 ck("a delayed save cannot replace the displayed import row's number",
    model.state.onboarding.step==SmartOnboardingStep.IMPORT_MEMBER&&!model.state.onboarding.rows.single().verified)
 model.onboardingSaveRow("Example Member","0780000001")
 ck("correcting an invalid row keeps the preview and selects the verified row",model.state.onboarding.rows.single().verified&&Fixture.onboardingPreviews==2)
 model.closeSheet()
 ck("closing a reviewed but unsubmitted member batch asks before discarding it",
    model.state.sheet==Sheet.ENROLL&&model.state.discardRequested&&model.state.onboarding.rows.single().verified)
 model.keepDraft()
 model.onboardingManual();model.onboardingSuggestions();model.onboardingPhoto()
 ck("source switches cannot silently discard a reviewed batch",model.state.onboarding.step==SmartOnboardingStep.IMPORT&&model.state.onboarding.rows.single().verified&&model.state.onboarding.sourceKind!=null)
 model.onboardingEditRow(1);model.editDraft("phone","0780000002")
 ck("editing a reviewed row requires fresh confirmations",confirmations().none{it})
 model.onboardingSubmitBatch();model.awaitIdle()
 ck("a delayed batch submission cannot register rows while a member is being edited",Fixture.onboardingImports==0)
 model.onboardingImport()
 ck("returning to the batch keeps the original verified row protected",model.state.draftDirty&&model.state.onboarding.rows.single().verified)
 model.onboardingSubmitBatch();model.awaitIdle()
 ck("verified batch is submitted once and displays its retained result",Fixture.onboardingImports==1&&model.state.onboarding.step==SmartOnboardingStep.RESULTS&&model.state.onboarding.created==1)
 ck("leaving the editor preserves the last verified import number",
    Fixture.lastOnboardingRows?.getJSONObject(0)?.getString("phone")==Values.phone("0780000001"))
 model.onboardingOptions();model.onboardingManual()
 model.onboardingConsent("terms",true,model.state.draft)
 ck("a consent change by itself is an unsaved enrollment edit",model.state.draftDirty)
 model.onboardingConsent("terms",false,model.state.draft)
 ck("reversing the only consent change leaves a new member form clean",!model.state.draftDirty)
 model.editDraft("name","Example Member");model.editDraft("phone","0780000001");confirmEntry()
 model.editDraft("name","Second Member")
 ck("a different member name clears the previous three confirmations",confirmations().none{it})
 confirmEntry();val previousDraft=model.state.draft;model.editDraft("phone","0780000002")
 ck("a different member number clears the previous three confirmations",confirmations().none{it})
 confirmEntry(previousDraft)
 ck("late consent callbacks cannot confirm the replacement member number",confirmations().none{it})
 model.onboardingSubmit("Second Member","0780000002");model.awaitIdle()
 ck("the edited number cannot be submitted with the old consent",Fixture.onboardingImports==1)
 confirmEntry();model.editDraft("phone","0780000002")
 ck("an unchanged input preserves the confirmations",confirmations().all{it})
 model.onboardingSubmit("Example Member","0780000001");model.awaitIdle()
 ck("a delayed manual save cannot submit a different identity",Fixture.onboardingImports==1)
 model.onboardingSubmit("Second Member","0780000002");model.awaitIdle()
 val sent=Fixture.lastOnboardingRows?.getJSONObject(0)
 ck("fresh confirmations submit the displayed identity once",Fixture.onboardingImports==2&&model.state.onboarding.step==SmartOnboardingStep.RESULTS&&
    sent?.getString("name")=="Second Member"&&sent.getString("phone")==Values.phone("0780000002")&&
    sent.getBoolean("verifiedOwnership")&&sent.getBoolean("acceptedTerms")&&sent.getBoolean("consentRecorded"))
 val suggestion=SmartOnboardingState(step=SmartOnboardingStep.MEMBER,candidate=SmartCandidate("source-2","Second Member","002",null,1),
    verifiedOwnership=true,acceptedTerms=true,consentRecorded=true)
 fun suggested(phone:String)=SmartOnboardingPresentation.confirmedMember(suggestion,mapOf("name" to "Second Member","phone" to phone),"Second Member",phone)
 ck("a verified suggestion keeps the original candidate and normalizes its matching number",
    suggested("0780000002").let{it.candidateId=="source-2"&&it.phone==Values.phone("0780000002")})
 ck("the suggested number's last three digits must still match",
    (runCatching{suggested("0780000003")}.exceptionOrNull() as? ContractFailure)?.code=="candidate_changed")
 model.closeSheet();model.openSheet(Sheet.ENROLL);model.awaitIdle();model.onboardingPhoto()
 val beforeLogout=startInput(model,MemberInputKind.CAMERA)
 model.onBackground();result(model,beforeLogout,"content://example/old.jpg");model.logout();model.awaitIdle();model.onForeground();model.awaitIdle()
 ck("sign out discards a camera result from the former session without upload",model.state.operator==null&&!model.state.onboarding.documentSelected&&Fixture.onboardingPreviews==2)
 model.viewModelScope.cancel()
 var timeOffset=0L
 val expired=BuriViewModel(Application()){System.currentTimeMillis()+timeOffset}
 expired.awaitIdle();expired.onForeground();expired.awaitIdle();expired.openSheet(Sheet.ENROLL);expired.awaitIdle();expired.onboardingPhoto()
 ck("camera starts from a freshly authorized enrollment sheet",expired.state.sheet==Sheet.ENROLL&&expired.state.onboarding.photoCaptureFlow)
 val expiring=startInput(expired,MemberInputKind.CAMERA)
 expired.onBackground()
 val advanced=expired.state.operator!!.expiresAt+1
 timeOffset=advanced-System.currentTimeMillis()
 Fixture.renewedExpiry=advanced+3_600_000
 Fixture.recordSavedAt=advanced
 result(expired,expiring,"content://example/expired-capture.jpg")
 ck("expired cached authority queues the owner-bound camera result without uploading",!expired.state.onboarding.documentSelected&&Fixture.onboardingPreviews==2)
 expired.onForeground();expired.awaitIdle()
 ck("renewed foreground authority releases the queued camera capture",expired.state.onboarding.documentUri=="content://example/expired-capture.jpg"&&expired.state.onboarding.photoPreviewPending&&expired.state.onboarding.ocrConsent)
 expired.onboardingOptions();expired.onboardingImport()
 val staleSession=startInput(expired,MemberInputKind.PHOTO)
 Fixture.processSessionEpoch.incrementAndGet()
 ck("a replacement session for the same account cannot reuse a previous launch",!result(expired,staleSession,"content://example/rotated.jpg"))
 expired.onboardingPhoto();val revoked=startInput(expired,MemberInputKind.CAMERA);expired.onBackground()
 result(expired,revoked,"content://example/revoked-capture.jpg")
 Fixture.refreshedCaps=setOf(Capability.READ.key)
 expired.onForeground();expired.awaitIdle()
 ck("revoked enrollment access never releases or uploads the queued camera capture",!expired.state.onboarding.documentSelected&&!expired.state.onboarding.photoPreviewPending&&Fixture.onboardingPreviews==2)
 Fixture.renewedExpiry=null;Fixture.recordSavedAt=null;Fixture.refreshedCaps=null;expired.viewModelScope.cancel()
 val background=BuriViewModel(Application())
 val entered=java.util.concurrent.CountDownLatch(1)
 val release=java.util.concurrent.CountDownLatch(1)
 try{
  background.awaitIdle();background.onForeground();background.awaitIdle();background.openSheet(Sheet.ENROLL);background.awaitIdle();background.onboardingImport()
  val uri="content://example/background.csv"
  val requestId=startInput(background,MemberInputKind.DOCUMENT)
  result(background,requestId,uri,"text/csv");background.awaitIdle()
  val selection=checkNotNull(background.currentMemberSelection(requestId,false))
  Fixture.onboardingPreviewEntered=entered;Fixture.onboardingPreviewRelease=release
  val input="synthetic rows".toByteArray()
  background.previewMemberDocument(selection,"text/csv",input,false)
  withContext(Dispatchers.IO) { check(entered.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
  background.onBackground();release.countDown();background.awaitIdle()
  ck("a preview completed in the background does not publish member rows",
    background.state.onboarding.rows.isEmpty()&&background.state.onboarding.sourceKind==null&&input.all{it==0.toByte()})
  background.onForeground();background.awaitIdle()
  ck("foreground revalidation allows an explicit retry of the same selection",background.currentMemberSelection(requestId,false)===selection)
  val unsent = "prepared private source".toByteArray()
  val before = Fixture.onboardingPreviews
  background.previewMemberDocument(selection, "text/csv", unsent, false)
  check(background.state.busy)
  // Cancel the queued preview in the same UI event, before the fixture dispatcher runs it.
  background.viewModelScope.cancel()
  background.viewModelScope.coroutineContext[Job]!!.join()
  ck("cancelling the controller before preview starts wipes its transferred bytes without a request",
    unsent.all { it == 0.toByte() } && Fixture.onboardingPreviews == before)
 }finally{
  release.countDown();Fixture.onboardingPreviewEntered=null;Fixture.onboardingPreviewRelease=null;background.viewModelScope.cancel()
 }
 println("RESULT: $checks smart onboarding controller checks passed with synthetic boundaries; no live data or Android lifecycle claim.")
}
