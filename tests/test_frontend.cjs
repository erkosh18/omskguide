// Optional DOM integration checks. Requires jsdom in NODE_PATH or JSDOM_PATH.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM}=require(process.env.JSDOM_PATH||'jsdom');
const root=path.resolve(__dirname,'..');
const places=JSON.parse(fs.readFileSync(path.join(root,'data/places.json'),'utf8'));
const pages=['index','places','routes','guide','events','journal','reviews','about','admin'];
const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
async function waitFor(fn){for(let i=0;i<100;i++){if(fn())return;await pause()}throw new Error('DOM condition timed out')}
async function load(page,{admin=false,loggedIn=false,url='',storage={}}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(root,page+'.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,''),{url:'http://localhost:8000/'+page+'.html'+url,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,errors=[],calls=[];
 w.addEventListener('error',event=>errors.push(event.error||event.message));
 w.matchMedia=()=>({matches:false});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open')};
 w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
 let user=(loggedIn||admin)?{id:'u1',email:'qa@example.test',name:admin?'@baerovich':'QA traveller',avatar:'',role:admin?'admin':'user'}:null;
 let saved={favorites:[],visited:[],quizScore:0,checklist:[]};
 const entries=[],suggestions=[],reviews=[];
 w.fetch=async(endpoint,options={})=>{
  calls.push({endpoint,options});const data=options.body?JSON.parse(options.body):{};let payload={},status=200;
  switch(endpoint){
   case '/api/places':payload={places};break;
   case '/api/session':payload={user,csrf:user?'csrf-test':null};break;
   case '/api/login':case '/api/register':user={id:'u1',name:data.name||'QA traveller',email:data.email,role:'user',avatar:''};payload={user,csrf:'csrf-test'};break;
   case '/api/logout':user=null;payload={ok:true};break;
   case '/api/state':if(options.method==='POST')saved=data;payload={state:saved};break;
   case '/api/diary':if(options.method==='POST')entries.push({id:'d1',place_id:data.placeId,text:data.text,visited:data.visited,photos:data.photos});payload={entries};break;
   case '/api/suggestions':if(options.method==='POST')suggestions.push({id:'s1',payload:data,status:'pending'});payload={suggestions};break;
   case '/api/reviews':if(options.method==='POST')reviews.push({id:'r1',user_id:'u1',name:'QA traveller',avatar:'',place_id:data.placeId,rating:data.rating,text:data.text,photos:data.photos,status:'pending',created:new Date().toISOString()});payload={reviews};break;
   case '/api/weather':payload={current:{temperature_2m:8,apparent_temperature:5,precipitation:0,weather_code:2,wind_speed_10m:12},daily:{},updated:new Date().toISOString(),stale:false};break;
   case '/api/events':payload={events:[{id:'e1',title:'Спектакль',titleEn:'A play',venue:'Театр',venueEn:'Theatre',date:'2026-12-01T19:00:00+06:00',description:'16+',descriptionEn:'16+',url:'https://example.org',source:'https://omskdrama.ru/affiche/',price:null}],updated:new Date().toISOString(),stale:false};break;
   case '/api/admin':payload={places,reviews:[],suggestions:[],events:[]};break;
   case '/api/admin/place':payload={place:data};break;
   case '/api/admin/event':payload={event:data};break;
   default:payload={ok:true};
  }
  return {ok:status<400,status,json:async()=>payload};
 };
 for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,JSON.stringify(value));
 w.eval(['content.js','catalog.js','qrcode.js','components.js','app.js'].map(filename=>fs.readFileSync(path.join(root,'assets',filename),'utf8')).join('\n'));
 await waitFor(()=>calls.some(c=>c.endpoint==='/api/session'));await pause();await pause();
 const $=selector=>d.querySelector(selector);
 const click=selector=>{assert.ok($(selector),'Missing '+selector);$(selector).click()};
 const change=(selector,value,type='change')=>{$(selector).value=value;$(selector).dispatchEvent(new w.Event(type,{bubbles:true}))};
 const submit=selector=>$(selector).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 return {dom,w,d,$,click,change,submit,calls,errors};
}
async function run(){
 for(const page of pages){const ctx=await load(page);assert.deepEqual(ctx.errors,[],page+' must boot without errors');assert.equal(ctx.d.documentElement.lang,'ru');assert.ok(ctx.$('nav a[href="places.html"]'));ctx.click('[data-lang="en"]');assert.equal(ctx.d.documentElement.lang,'en');assert.deepEqual(ctx.errors,[],page+' EN');ctx.dom.window.close()}
 {
  const c=await load('places');c.change('#search','пельмени','input');assert.equal(c.d.querySelectorAll('#placeCards article').length,1);c.click('#placeCards [data-favorite]');assert.equal(c.$('#favCount').textContent,'1');c.click('#resetFilters');
  c.click('[data-category="coffee"]');c.change('#budgetFilter','low');assert.equal(c.d.querySelectorAll('#placeCards article').length,4);c.click('#resetFilters');
  c.click('#placeCards [data-compare="lyubinsky"]');c.click('#placeCards [data-compare="skuratov"]');c.click('#openCompare');assert.ok(c.$('#compareDialog').open);assert.match(c.$('#compareContent').textContent,/Skuratov/);c.click('#compareDialog [data-close]');
  c.click('#placeCards [data-review="strelka"]');assert.ok(c.$('#accountDialog').open);assert.ok(!c.$('#reviewDialog').open);c.dom.window.close();
 }
 {
  const c=await load('routes');c.click('[data-quick="60"]');assert.equal(c.d.querySelectorAll('.stop').length,2);assert.match(c.$('#routeSummary').textContent,/60 мин/);assert.match(c.$('#budgetResult').textContent,/450/);
  c.change('#people','2','input');assert.match(c.$('#budgetResult').textContent,/900/);c.click('#rainRoute');assert.match(c.$('#routeSummary').textContent,/погоду/);assert.ok(c.d.querySelectorAll('.stop').length>=1);c.click('#rainRoute');assert.equal(c.d.querySelectorAll('.stop').length,2);
  c.click('#routeQR');assert.ok(c.$('#routeQRCode svg'));c.click('#qrDialog [data-close]');c.click('[data-mood="friends"]');assert.match(c.$('#timeline').textContent,/Public Pub/);
  c.submit('#builder');assert.equal(c.d.querySelectorAll('.stop').length,4);c.dom.window.close();
 }
 {
  const c=await load('guide');for(const answer of [1,1,2,0,0]){c.click('[data-answer="'+answer+'"]');c.click('#nextQuestion')}assert.match(c.$('#quizContent').textContent,/5 \/ 5/);assert.equal(JSON.parse(c.w.localStorage.getItem('omsk_state_guest')).quizScore,5);
  c.click('[data-season="0"]');assert.match(c.$('#seasonContent').textContent,/−30/);assert.match(c.$('#checklist').textContent,/Варежки/);c.click('[data-checklist="water"]');assert.ok(JSON.parse(c.w.localStorage.getItem('omsk_state_guest')).checklist.includes('water'));c.click('#largeToggle');assert.equal(c.d.documentElement.dataset.large,'true');c.dom.window.close();
 }
 {
  const c=await load('journal',{loggedIn:true});c.click('#newDiary');c.change('#diaryForm [name="text"]','Private diary memories');c.submit('#diaryForm');await waitFor(()=>!c.$('#diaryDialog').open);assert.match(c.$('#diaryList').textContent,/Private diary/);c.click('#suggestPlace');c.change('#suggestionForm [name="name"]','A new place');c.change('#suggestionForm [name="address"]','Omsk central street');c.change('#suggestionForm [name="description"]','A lovely new discovery');c.submit('#suggestionForm');await waitFor(()=>!c.$('#suggestionDialog').open);assert.match(c.$('#mySuggestions').textContent,/A new place/);c.dom.window.close();
 }
 {
  const c=await load('reviews');c.click('#writeReview');c.change('#authForm [name="name"]','QA traveller');c.change('#authForm [name="email"]','qa@example.test');c.change('#authForm [name="password"]','Testing-only-2026!');c.submit('#authForm');await waitFor(()=>c.$('#reviewDialog').open);c.change('#reviewText','A very good walk around Omsk.');c.submit('#reviewForm');await waitFor(()=>!c.$('#reviewDialog').open);assert.match(c.$('#reviewList').textContent,/На модерации/);assert.ok(c.calls.find(x=>x.endpoint==='/api/reviews'&&x.options.method==='POST').options.headers['X-CSRF-Token']);c.dom.window.close();
 }
 {
  const c=await load('admin');assert.ok(c.$('#adminWorkspace').hidden);assert.match(c.$('#adminGate').textContent,/администратора/);c.dom.window.close();
  const a=await load('admin',{admin:true});await waitFor(()=>!a.$('#adminWorkspace').hidden);assert.equal(a.$('#placeEditor [name="id"]').value,'embankment');a.click('#newPlace');a.change('#placeEditor [name="id"]','new-test');a.change('#placeEditor [name="ru"]','Новое место');a.change('#placeEditor [name="en"]','New place');a.change('#placeEditor [name="descRu"]','Описание нового места');a.change('#placeEditor [name="descEn"]','A new place description');a.change('#placeEditor [name="price"]','500');a.change('#placeEditor [name="rating"]','4.5');a.submit('#placeEditor');await waitFor(()=>a.$('#toast').textContent.includes('Место сохранено'));assert.deepEqual(a.errors,[]);a.dom.window.close();
 }
 console.log('PASS: all nine pages boot in RU/EN; search/filter; saved places; comparison; route duration/budget/rain/QR/moods; quiz; checklist; large mode; account-gated reviews; diary; suggestions; admin gate/editor.');
}
run().catch(error=>{console.error(error);process.exitCode=1});
