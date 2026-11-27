import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixtureMember,fixtureInactiveMember,fixturePayment} from './operator-read-fixture.mjs';

export async function verifyVisibleFinancialLabels(page){
  for (const width of [320,1280]){
    await page.setViewportSize({width,height:800});
    for(const label of ['Cumulative incoming payments','Cumulative outgoing payments','Latest MoMo SMS balance']){
      const actual=page.locator('.overview-metric-label').filter({hasText:label});
      await actual.waitFor();
      assert(await actual.evaluate(el=>el.getBoundingClientRect().width>30 && el.getBoundingClientRect().height>12 &&
        !getComputedStyle(el).clipPath.includes('inset') && !!el.parentElement?.querySelector('svg')));
    }
  }
  await page.setViewportSize({width:1440,height:900});
}

export async function verifyRosterImages(page,root,origin){
  const preview=url=>url.origin===origin && url.pathname.endsWith('/members/enrollment/import/preview');
  const sent=[];
  const intercept=async route=>{
    const body=route.request().postDataJSON();
    const bytes=Buffer.from(body.fileBytes,'base64');
    sent.push({mime:body.mimeType,signature:bytes.subarray(0,3).toString('hex'),consent:body.externalOcrConsent});
    await route.fulfill({status:400,json:{error:{code:'smart_import_invalid_fixture'}}});
  };
  await page.route(preview,intercept);
  try{
    const picker=page.getByLabel('Roster file',{exact:true});
    const send=page.getByRole('button',{name:'Send to OpenAI for preview',exact:true});
    const corpus=join(root,'tools/roster-decoder/native-probe/corpus');
    for(const file of ['animation-3.png','animation-3.webp']){
      await picker.setInputFiles(join(corpus,file));
      await send.click();
      await page.getByRole('alert').filter({hasText:'Choose a still image'}).waitFor();
      assert.equal(sent.length,0);
    }
    await picker.setInputFiles(join(corpus,'scanned-multilingual.png'));
    await send.click();
    await page.getByRole('alert').filter({hasText:'Check the file format'}).waitFor();
    assert.deepEqual(sent,[{mime:'image/jpeg',signature:'ffd8ff',consent:true}]);
  }finally{await page.unroute(preview,intercept);}
}

export async function verifyTwoEmptyStatements(page,origin){
  const members=[fixtureMember,fixtureInactiveMember];
  const match=url=>url.origin===origin && members.some(m=>url.pathname==='/api/admin/operations/members/'+m.id) &&
    url.searchParams.get('include')==='statement';
  const emptyStatement=async route=>{
    const response=await route.fetch(), document=await response.json(), statement=document.member_statement;
    assert(statement?.membershipId);
    document.member_statement={...statement,totalCount:0,closingRwf:'0',items:[],revision:createHash('sha256').update('empty/'+statement.membershipId).digest('hex')};
    await route.fulfill({response,json:document});
  };
  await page.route(match,emptyStatement);
  const files=[];
  try{
    for(const member of members){
      await page.goto(origin+'/#/admin/members/'+member.id+'/statement');
      await page.getByRole('heading',{name:'No member transactions'}).waitFor();
      const download=page.waitForEvent('download');
      await page.getByRole('button',{name:'Download statement',exact:true}).click();
      const file=await download;
      const csv=await readFile(await file.path(),'utf8');
      assert.match(csv,/Statement read as of \(UTC\)/);assert.match(csv,/Closing balance,,,,,0/);
      assert(!csv.includes(member.id));files.push({name:file.suggestedFilename(),csv});
    }
    assert.notEqual(files[0].name,files[1].name);assert.notEqual(files[0].csv,files[1].csv);
  }finally{await page.unroute(match,emptyStatement);}
}

export async function verifyContinuedAllocation(page,origin){
  const path='/api/admin/burimunsi/payments';
  const finder=url=>url.origin===origin && url.pathname===path+'/members';
  const detail=url=>url.origin===origin && url.pathname===path+'/'+fixturePayment.id;
  const members=Array.from({length:31},(_,i)=>({id:'synthetic-'+String(i+1).padStart(3,'0'),name:'Same roster name',
    publicId:String(800001+i),memberNumber:String(100000000001+i)}));
  const requests=[];
  const choices=async route=>{
    const params=new URL(route.request().url()).searchParams, q=params.get('q')??'', after=params.get('after');
    requests.push({q,after});
    const remaining=members.filter(m=>(!q||m.name.includes(q)||m.publicId===q||m.memberNumber===q)&&(!after||m.id>after));
    const items=remaining.slice(0,25);
    await route.fulfill({json:{items,nextCursor:remaining.length>25?items.at(-1).id:null}});
  };
  const show=route=>route.fulfill({json:{...fixturePayment,canAllocate:true}});
  await page.route(finder,choices);await page.route(detail,show);
  try{
    await page.goto(origin+'/#/admin/payments?allocate='+fixturePayment.id);
    const select=page.getByRole('button',{name:'Choose member',exact:true});
    await select.click();
    const picker=page.getByRole('dialog',{name:'Select member',exact:true});
    const search=picker.getByRole('searchbox');
    await search.fill('Same roster name');await search.press('Enter');
    await picker.getByRole('button',{name:'Next members',exact:true}).click();
    const label=members[29].name+' · '+members[29].memberNumber;
    await picker.getByRole('button',{name:label,exact:true}).click();
    assert.equal(await select.innerText(),label);
    await select.click();
    await search.fill(members[29].memberNumber);await search.press('Enter');
    await picker.getByRole('button',{name:label,exact:true}).click();
    await page.getByRole('button',{name:'Review allocation',exact:true}).click();
    await page.getByRole('heading',{name:'Review allocation'}).waitFor();
    assert(await page.getByText(members[29].id,{exact:true}).isVisible());
    assert(requests.some(r=>r.q==='Same roster name'&&r.after===members[24].id));
    assert(requests.some(r=>r.q===members[29].memberNumber));
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
  }finally{await page.unroute(finder,choices);await page.unroute(detail,show);}
}
