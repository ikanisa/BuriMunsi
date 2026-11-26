import {BuriError,requireThat} from './errors.js';
import {SMART_IMPORT_LIMITS} from './smart-onboarding-source.js';
import {requireActiveNativeRequest} from './wire/request-boundary.mjs';

/** Both clients use the same bounded source and cancellation rules. */
export async function previewOnboardingFile(request,input,preview) {
  requireActiveNativeRequest(request);
  const encoded=input.fileBytes;
  requireThat(typeof encoded==='string'&&encoded.length>0&&encoded.length%4===0&&
    encoded.length<=4*Math.ceil(SMART_IMPORT_LIMITS.documentBytes/3)&&/^[A-Za-z0-9+/]*={0,2}$/.test(encoded),'smart_import_invalid');
  let binary;
  try{binary=atob(encoded);}catch{throw new BuriError('smart_import_invalid');}
  requireThat(binary.length>0&&binary.length<=SMART_IMPORT_LIMITS.documentBytes&&btoa(binary)===encoded,'smart_import_invalid');
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<bytes.length;i++)bytes[i]=binary.charCodeAt(i);
  try{
    const result=await preview({bytes,mimeType:input.mimeType,externalOcrConsent:input.externalOcrConsent,
      importFlowId:input.importFlowId,ocrDisclosureVersion:input.ocrDisclosureVersion,signal:request.signal});
    requireActiveNativeRequest(request);
    return result;
  }catch(error){
    requireActiveNativeRequest(request);
    throw error;
  }finally{bytes.fill(0);}
}
