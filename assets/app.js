'use strict';
const BOT_URL='https://t.me/OmskGuide55_Bot';
const ADMIN_URL='https://t.me/baerovich';
const DISPLAY_TZ='Asia/Qyzylorda';
const $=(s,root=document)=>root.querySelector(s);
const $$=(s,root=document)=>[...root.querySelectorAll(s)];
const page=document.body.dataset.page;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bi=(ru,en)=>lang==='ru'?ru:en;
const tr=key=>TEXT[key]?.[lang==='ru'?0:1]??key;
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]||ICONS.compass}"/></svg>`;
function read(key,fallback){try{return JSON.parse(localStorage.getItem('omsk_'+key))??fallback}catch{return fallback}}
function save(key,value){try{localStorage.setItem('omsk_'+key,JSON.stringify(value));return true}catch{toast(tr('storageError'));return false}}
let lang=read('lang','ru');if(!['ru','en'].includes(lang))lang='ru';
let PLACES=window.OMSK_PLACES||[],user=null,csrf=null,serverOnline=false;
const byId=id=>PLACES.find(p=>p.id===id);
const nameOf=p=>bi(p.ru,p.en);
const gis=p=>'https://2gis.ru/omsk/search/'+encodeURIComponent(p.ru);
const safePhoto=url=>typeof url==='string'&&(/^(https:\/\/|data:image\/(jpeg|png|webp);base64,)/.test(url))?url:'';
const photo=p=>safePhoto(p.photo)||PHOTOS[p.image]||placeholder(p.image,nameOf(p));
const initialState=()=>({favorites:[],visited:[],checklist:[],quizScore:0});
let state={...initialState(),...read('state_guest',{})};
let favorites=new Set(state.favorites.filter(id=>byId(id))),visited=new Set(state.visited.filter(id=>byId(id)));
let compareSet=new Set(read('compare',[]).filter(id=>byId(id))),journalTab='favorites';
let category='all',topOnly=false,shown=9,filtered=[],map,markers;
let routeIndex=0,customRoute=read('route',null),beforeRain=null;
if(customRoute&&(!Array.isArray(customRoute.ids)||!customRoute.ids.length||customRoute.ids.length>10||!customRoute.ids.every(byId)||![.5,1,1.5,3,5,8].includes(customRoute.hours)))customRoute=null;
let season=Math.floor((new Date().getMonth()+1)%12/3),quizIndex=0,quizScore=0,quizAnswered=false,factIndex=0;
let authMode='register',pendingAction=null,avatarDraft='',reviewPlace='site';
let reviewRows=[],diaryRows=[],suggestionRows=[],eventData=null,weatherData=null,adminData=null;
let currentDiary=null,editorPlace=null,qrSVG='',voices=[],utterance=null;
let toastTimer,syncTimer,syncQueue=Promise.resolve(),lastSyncError=false;
ICONS.play='m8 4 12 8-12 8V4Z';ICONS.compare='M3 3v18h18M8 17V9m5 8V5m5 12v-6';
ICONS.book='M4 3h14a2 2 0 0 1 2 2v17H6a2 2 0 0 1-2-2V3Zm0 15h16';
Object.assign(TEXT,{
 localReviews:['Отзывы и фотографии отправляются на модерацию. Личный дневник виден только вам.','Reviews and photos are sent for moderation. Your diary is private.'],
 reviewsSub:['Нашли особенное место? Расскажите о нём. Читать можно без регистрации, оставить отзыв — после входа в профиль.','Found somewhere special? Share your experience. Read freely; sign in to leave a review.'],
 disclaimer:['Независимый путеводитель. Цены и рейтинги ориентировочные. Проверяйте режим работы перед визитом.','Independent guide. Prices and ratings are estimates. Check opening hours before visiting.']
});
const on=(selector,event,fn)=>{const element=$(selector);if(element)element.addEventListener(event,fn)};
const htmlAt=(selector,value)=>{if($(selector))$(selector).innerHTML=value};
const textAt=(selector,value)=>{if($(selector))$(selector).textContent=value};
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200)}
function showDialog(id){const dialog=$(id);if(!dialog.open)dialog.showModal()}
function hydrate(root=document){
 $$('[data-icon]',root).forEach(el=>el.innerHTML=icon(el.dataset.icon));
 $$('[data-i18n]',root).forEach(el=>el.innerHTML=tr(el.dataset.i18n));
 $$('[data-ru][data-en]',root).forEach(el=>el.textContent=bi(el.dataset.ru,el.dataset.en));
 $$('[data-placeholder]',root).forEach(el=>el.placeholder=tr(el.dataset.placeholder));
 $$('[data-aria]',root).forEach(el=>{el.setAttribute('aria-label',tr(el.dataset.aria));el.title=tr(el.dataset.aria)});
}
function dateParts(date=new Date(),timeZone=DISPLAY_TZ){const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`}
function prettyDate(value,withTime=false,timeZone=DISPLAY_TZ){return new Intl.DateTimeFormat(lang==='ru'?'ru-RU':'en-GB',{timeZone,day:'numeric',month:'long',year:'numeric',...(withTime?{hour:'2-digit',minute:'2-digit'}:{})}).format(new Date(value))}
function errorMessage(message,status){
 const translations={
 'Please sign in first':'Сначала войдите в профиль.',
 'Administrator access required':'Доступ разрешён только администратору.',
 'Incorrect email or password':'Неверный email или пароль.',
 'This email is already registered. Please sign in.':'Этот email уже зарегистрирован. Войдите в профиль.',
 'Too many attempts. Please try again later.':'Слишком много попыток. Попробуйте позже.',
 'Session token missing or expired. Refresh the page.':'Сессия устарела. Обновите страницу и войдите снова.',
 'Enter a valid email address':'Введите корректный email.',
 'Use an HTTPS URL':'Укажите ссылку, начинающуюся с https://.',
 'Weather provider is temporarily unavailable':'Сервис погоды временно недоступен.',
 'Up to three images are allowed':'Можно прикрепить не более трёх фотографий.',
 'Image is too large':'Фотография слишком большая.',
 'This entry belongs to another user':'Эта запись принадлежит другому пользователю.'
 };
 if(lang==='en')return message;
 if(translations[message])return translations[message];
 if(status===403)return 'Недостаточно прав или устарела сессия. Войдите заново.';
 if(status===400)return 'Проверьте заполнение полей и формат данных.';
 if(status>=500)return 'Сервис временно недоступен. Попробуйте позже.';
 return message;
}
async function api(path,method='GET',data){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),17000);
 try{
  const response=await fetch(path,{method,credentials:'same-origin',signal:controller.signal,
   headers:{'Accept':'application/json',...(method!=='GET'?{'Content-Type':'application/json','X-Requested-With':'OmskGuide',...(csrf?{'X-CSRF-Token':csrf}:{})}:{})},
   ...(method!=='GET'?{body:JSON.stringify(data||{})}:{})});
  const payload=await response.json();
  if(!response.ok){const error=new Error(errorMessage(payload.error||'Request failed',response.status));error.status=response.status;throw error}
  return payload;
 }catch(error){
  if(error.status)throw error;
  throw new Error(bi('Не удалось связаться с сервером. Проверьте соединение и повторите.','Could not reach the server. Check your connection and try again.'));
 }finally{clearTimeout(timer)}
}
function currentUser(){return user}
function updateCounters(){textAt('#favCount',favorites.size);textAt('#placeStat',PLACES.length);updateCompareBar()}
function stateKey(){return 'state_'+(user?.id||'guest')}
function persistState(){
 state.favorites=[...favorites];state.visited=[...visited];save(stateKey(),state);updateCounters();
 if(user){clearTimeout(syncTimer);const snapshot=JSON.parse(JSON.stringify(state)),expectedUser=user.id;
  syncTimer=setTimeout(()=>{syncQueue=syncQueue.catch(()=>{}).then(async()=>{
   if(user?.id!==expectedUser)return;
   try{await api('/api/state','POST',snapshot);lastSyncError=false;textAt('#syncStatus',bi('Сохранено в профиле','Saved to your profile'))}
   catch(error){textAt('#syncStatus',bi('Изменения пока только на этом устройстве. Повторите сохранение.','Changes are only on this device for now. Try saving again.'));if(!lastSyncError)toast(error.message);lastSyncError=true}
  })},300);
 }
}
async function loadState(mergeGuest=false){
 if(user){const remote=await api('/api/state');state={...initialState(),...remote.state};
  if(mergeGuest){const guest=read('state_guest',{});state.favorites=[...new Set([...state.favorites,...(guest.favorites||[])])];state.visited=[...new Set([...state.visited,...(guest.visited||[])])]}
 }else state={...initialState(),...read('state_guest',{})};
 favorites=new Set(state.favorites.filter(id=>byId(id)));visited=new Set(state.visited.filter(id=>byId(id)));save(stateKey(),state);
 if(mergeGuest)persistState();updateCounters();
}
function card(p){
 const saved=favorites.has(p.id),was=visited.has(p.id),compared=compareSet.has(p.id),real=Boolean(safePhoto(p.photo)||PHOTOS[p.image]);
 const cat=CATEGORIES.find(c=>c[0]===p.cats[0])||CATEGORIES[1];
 const cost=p.priceUnknown?bi('Бюджет уточняется','Budget to be confirmed'):p.price===0?bi('Прогулка бесплатно','Free outdoor visit'):bi('Ориентир: ','Estimate: ')+p.price.toLocaleString(lang==='ru'?'ru-RU':'en-GB')+' ₽';
 return `<article class="place-card"><div class="card-image"><img src="${esc(photo(p))}" alt="${esc((real?'':bi('Фото-заглушка: ','Photo placeholder: '))+nameOf(p))}" loading="lazy" width="800" height="500"><span class="pill">${bi(cat[2],cat[3])}</span><button class="icon-btn favorite-btn ${saved?'saved':''}" data-favorite="${p.id}" aria-pressed="${saved}" aria-label="${bi(saved?'Убрать из избранного':'В избранное',saved?'Remove saved place':'Save place')}">${icon('heart')}</button>${!real?`<span class="photo-note">${bi('Фото-заглушка','Photo placeholder')}</span>`:''}</div><div class="card-content"><div class="card-top"><h3>${esc(nameOf(p))}</h3><span class="rating" aria-label="${bi('Ориентировочный рейтинг','Illustrative rating')}">${p.rating?icon('star')+p.rating.toFixed(1):'—'}</span></div><p>${esc(bi(p.descRu,p.descEn))}</p><div class="card-bottom"><span>${cost}</span><a href="${gis(p)}" target="_blank" rel="noopener">${bi('Открыть в 2ГИС','Open in 2GIS')}${icon('arrowUpRight')}</a></div><div class="card-actions"><button data-visited="${p.id}" class="${was?'visited':''}" aria-pressed="${was}">${icon('check')}${bi(was?'Уже был':'Отметить визит',was?'Visited':'Mark visited')}</button><button data-compare="${p.id}" class="${compared?'compare-selected':''}" aria-pressed="${compared}">${icon('compare')}${bi(compared?'В сравнении':'Сравнить',compared?'Comparing':'Compare')}</button><button data-audio="${p.id}">${icon('play')}${bi('Послушать','Listen')}</button><button data-review="${p.id}">${icon('edit')}${bi('Отзыв','Review')}</button></div></div></article>`;
}
function filterPlaces(){
 if(!$('#search')){filtered=PLACES.slice();return}
 const query=$('#search').value.toLowerCase().trim().replaceAll('ё','е'),budget=$('#budgetFilter').value,min=Number($('#ratingFilter').value);
 filtered=PLACES.filter(p=>(category==='all'||p.cats.includes(category))&&(!query||`${p.ru} ${p.en} ${p.descRu} ${p.descEn} ${p.tags}`.toLowerCase().replaceAll('ё','е').includes(query))&&p.rating>=min&&(budget==='all'||(!p.priceUnknown&&((budget==='low'&&p.price<500)||(budget==='mid'&&p.price>=500&&p.price<=1500)||(budget==='high'&&p.price>1500)))));
 if($('#sortFilter').value==='rating'||topOnly)filtered.sort((a,b)=>b.rating-a.rating);
 if($('#sortFilter').value==='price'&&!topOnly)filtered.sort((a,b)=>(a.priceUnknown?Infinity:a.price)-(b.priceUnknown?Infinity:b.price));
 if(topOnly)filtered=filtered.slice(0,10);renderCards();renderMarkers();
}
function empty(ru,en,subRu='',subEn=''){return `<div class="empty"><h3>${bi(ru,en)}</h3>${subRu?`<p>${bi(subRu,subEn)}</p>`:''}</div>`}
function renderCards(){if(!$('#placeCards'))return;$('#placeCards').innerHTML=filtered.length?filtered.slice(0,shown).map(card).join(''):empty('Пока ничего не нашли','No matches yet','Измените запрос или сбросьте фильтры.','Try another search or reset the filters.');textAt('#resultsCount',bi(`Найдено: ${filtered.length} · показано ${Math.min(shown,filtered.length)}`,`${filtered.length} places found · ${Math.min(shown,filtered.length)} shown`));$('#loadMore').hidden=shown>=filtered.length;$('#topTen').setAttribute('aria-pressed',String(topOnly));$('#topTen').style.color=topOnly?'var(--terra)':'';updateCounters()}
function resetFilters(){category='all';topOnly=false;shown=9;$('#search').value='';$('#budgetFilter').value='all';$('#ratingFilter').value='0';$('#sortFilter').value='editor';renderCategories();filterPlaces()}
function updateCompareBar(){if($('#compareBar'))$('#compareBar').hidden=compareSet.size===0;textAt('#compareCount',bi(`Выбрано: ${compareSet.size} / 4`,`${compareSet.size} / 4 selected`));if($('#openCompare'))$('#openCompare').disabled=compareSet.size<2}
function renderComparison(){
 const list=[...compareSet].map(byId).filter(Boolean);
 const rows=[[bi('Категория','Category'),p=>p.cats.map(c=>{const cat=CATEGORIES.find(x=>x[0]===c);return bi(cat[2],cat[3])}).join(', ')],[bi('Бюджет','Budget'),p=>p.priceUnknown?'—':p.price+' ₽'],[bi('Рейтинг, ориентир','Rating estimate'),p=>p.rating||'—'],[bi('Время, ориентир','Time estimate'),p=>(p.minutes||50)+' '+bi('мин','min')],[bi('В помещении','Indoors'),p=>bi(p.indoor?'Да':'Нет',p.indoor?'Yes':'No')],[bi('Что интересного','What to expect'),p=>bi(p.descRu,p.descEn)]];
 $('#compareContent').innerHTML=`<table class="comparison-table"><thead><tr><th>${bi('Ваш выбор','Your choices')}</th>${list.map(p=>`<th>${esc(nameOf(p))}</th>`).join('')}</tr></thead><tbody>${rows.map(([label,fn])=>`<tr><td>${label}</td>${list.map(p=>`<td>${esc(fn(p))}</td>`).join('')}</tr>`).join('')}<tr><td>2GIS</td>${list.map(p=>`<td><a href="${gis(p)}" target="_blank" rel="noopener">${bi('Открыть','Open')}</a></td>`).join('')}</tr></tbody></table>`;
}
function currentRoute(){return customRoute||{ids:ROUTES[routeIndex][2].filter(byId),title:bi(ROUTES[routeIndex][0],ROUTES[routeIndex][1]),hours:8}}
function routeTitle(route=currentRoute()){return route.titleRu?bi(route.titleRu,route.titleEn):route.title}
function stops(){const r=currentRoute(),interval=r.hours*60/r.ids.length;return r.ids.map((id,i)=>{const mins=600+Math.round(i*interval/5)*5;return {p:byId(id),time:`${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`}}).filter(x=>x.p)}
function renderRoutes(){
 if(!$('#timeline'))return;
 $('#routeTabs').innerHTML=ROUTES.map(([ru,en],i)=>`<button class="tab ${!customRoute&&routeIndex===i?'active':''}" data-route="${i}" aria-pressed="${!customRoute&&routeIndex===i}">${bi(ru,en)}</button>`).join('');
 const r=currentRoute();textAt('#routeSummary',`${routeTitle(r)} · ${r.ids.length} ${bi('остановки','stops')} · ~${r.hours<2?r.hours*60+' '+bi('мин','min'):r.hours+' '+bi('ч','h')} · ${bi('время и переезды ориентировочные','times and travel are approximate')}`);
 $('#timeline').innerHTML=stops().map(({p,time})=>`<div class="stop"><time>${time}</time><div><h3><a href="${gis(p)}" target="_blank" rel="noopener">${esc(nameOf(p))}${icon('arrowUpRight')}</a></h3><p>${esc(bi(p.descRu,p.descEn))}</p></div></div>`).join('');
 $('#rainRoute').setAttribute('aria-pressed',String(Boolean(beforeRain)));$('#rainRoute').classList.toggle('rain-active',Boolean(beforeRain));renderBudget();
 save('route',{...r,title:undefined,titleRu:r.titleRu||ROUTES[routeIndex][0],titleEn:r.titleEn||ROUTES[routeIndex][1]});
}
function setRoute(ids,hours,ru,en){customRoute={ids:[...new Set(ids)].filter(byId),hours,titleRu:ru,titleEn:en};beforeRain=null;renderRoutes()}
function buildQuick(minutes){const lists={30:['lyubinsky'],60:['lyubinsky','skuratov'],90:['lyubinsky','fortress','strelka']};if(page!=='routes'){location.href='routes.html?quick='+minutes;return}setRoute(lists[minutes]||lists[60],minutes/60,`Прогулка на ${minutes} минут`,`${minutes}-minute walk`);textAt('#builderStatus',bi('Короткий маршрут готов. Длительность ориентировочная.','Your short route is ready. Times are approximate.'))}
function moodRoute(mood){const map={quiet:[['birds','genze','embankment'],5,'Хочу тишины','Some peace'],date:[['kuznya','lyubinsky','miller','strelka'],5,'На свидание','A date'],friends:[['meat','lyubinsky','public','1984'],5,'С друзьями','With friends'],rain:[['skuratov','vrubel','historymuseum','drama'],5,'Спрятаться от дождя','Out of the rain']};const r=map[mood];if(r)setRoute(...r)}
function toggleRain(){
 if(beforeRain){customRoute=beforeRain;beforeRain=null;renderRoutes();return}
 beforeRain={...currentRoute(),ids:[...currentRoute().ids],titleRu:currentRoute().titleRu||ROUTES[routeIndex][0],titleEn:currentRoute().titleEn||ROUTES[routeIndex][1]};
 const alternatives=['vrubel','historymuseum','dostoevsky','skuratov','kitchen','joule','drama'],used=new Set();
 const ids=currentRoute().ids.map(id=>{const p=byId(id);const replacement=p?.indoor?id:alternatives.find(next=>!used.has(next)&&!currentRoute().ids.includes(next))||'vrubel';used.add(replacement);return replacement});
 customRoute={...beforeRain,ids:[...new Set(ids)],titleRu:'План на плохую погоду',titleEn:'Rainy-day plan'};renderRoutes();toast(bi('Уличные остановки заменены. Проверьте часы работы.','Outdoor stops replaced. Check opening hours.'));
}
function renderBudget(){if(!$('#budgetResult'))return;const people=Number($('#people').value),transport=Number($('#transport').value);if(!Number.isInteger(people)||people<1||people>8||!Number.isFinite(transport)||transport<0||transport>10000){textAt('#budgetResult',bi('Укажите 1–8 человек и транспорт от 0 до 10 000 ₽.','Enter 1–8 people and transport from RUB 0 to 10,000.'));return}const list=currentRoute().ids.map(byId).filter(Boolean),perPerson=list.reduce((sum,p)=>sum+(p.priceUnknown?0:p.price),0)+transport;$('#budgetResult').innerHTML=list.map(p=>`<div class="budget-line"><span>${esc(nameOf(p))}</span><span>${p.priceUnknown?'—':p.price+' ₽'}</span></div>`).join('')+`<div class="budget-line"><span>${bi('Транспорт','Transport')}</span><span>${transport} ₽</span></div><div class="budget-total">≈ ${(perPerson*people).toLocaleString(lang==='ru'?'ru-RU':'en-GB')} ₽</div><p class="small">${bi(`На ${people} чел. · ${perPerson} ₽ на человека`,`For ${people} people · RUB ${perPerson} per person`)}${list.some(p=>p.priceUnknown)?bi('. Некоторые цены уточняются и не включены.','. Some unconfirmed prices are excluded.'):''}</p>`}
function routeText(){return tr('brand')+' — '+routeTitle()+'\n\n'+stops().map(({p,time})=>`${time} — ${nameOf(p)}\n${gis(p)}`).join('\n\n')+'\n\n'+bi('Время и цены ориентировочные. Уточняйте часы работы и переезды.','Times and prices are approximate. Check opening hours and travel times.')}
function routeURL(){const r=currentRoute(),url=new URL('routes.html',location.href);url.hash='route='+encodeURIComponent(JSON.stringify({ids:r.ids,hours:r.hours}));return url.href}
function restoreRoute(){
 const query=new URLSearchParams(location.search);if(query.has('quick')){buildQuick(Number(query.get('quick')));return}
 let data=null;if(location.hash.startsWith('#route=')){try{data=JSON.parse(decodeURIComponent(location.hash.slice(7)))}catch{toast(bi('Ссылка на маршрут повреждена.','This route link is invalid.'));return}}else data=read('route',null);
 if(data&&Array.isArray(data.ids)&&data.ids.length&&data.ids.length<=10&&data.ids.every(byId)&&[.5,1,1.5,3,5,8].includes(data.hours))customRoute={ids:[...new Set(data.ids)],hours:data.hours,titleRu:data.titleRu||'Ваш маршрут',titleEn:data.titleEn||'Your route'};
 renderRoutes();
}
function showQR(){if(!window.qrcode){toast(bi('Генератор QR недоступен.','QR generator unavailable.'));return}const qr=qrcode(0,'M');qr.addData(routeURL());qr.make();qrSVG=qr.createSvgTag({cellSize:4,margin:16,scalable:true});$('#routeQRCode').innerHTML=qrSVG;textAt('#qrNote',/^(localhost|127\.)/.test(location.hostname)?bi('Этот адрес локальный. Для открытия на другом телефоне используйте сетевой или опубликованный адрес сайта.','This is a local address. Use a LAN or published site address to open it on another phone.'):bi('Отсканируйте камерой телефона: откроется именно этот маршрут.','Scan with your phone camera to open this exact route.'));showDialog('#qrDialog')}
function download(filename,text,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000)}

function avatarMarkup(person){const url=safePhoto(person?.avatar);return url?`<img src="${esc(url)}" alt="${esc(bi('Аватар: ','Avatar: ')+(person.name||''))}">`:esc((person?.name||'?').slice(0,1).toUpperCase())}
function updateAccountButton(){const b=$('#accountButton');b.innerHTML=user?`<span class="avatar" style="width:27px;height:27px">${avatarMarkup(user)}</span>`:icon('user');b.setAttribute('aria-label',user?user.name:tr('account'))}
function requireAccount(action){if(user){action();return}pendingAction=action;authMode='register';renderAccount();showDialog('#accountDialog')}
function renderAccount(){
 if(user){$('#accountContent').innerHTML=`<div class="profile-summary"><div class="avatar-preview">${avatarMarkup(user)}</div><h3>${esc(user.name)}</h3><p>${esc(user.email)}</p><p class="small">${user.role==='admin'?bi('Администратор проекта · @baerovich','Project administrator · @baerovich'):bi('Ваши сохранённые места и записи доступны после входа на других устройствах.','Sign in on another device to access your saved places and diary.')}</p><form id="profileForm" class="profile-edit dialog-form"><label>${bi('Имя','Name')}<input name="name" value="${esc(user.name)}" required minlength="2" maxlength="40"></label><label>${bi('Обновить аватарку','Update avatar')}<input type="file" name="avatar" accept="image/png,image/jpeg,image/webp"></label><p id="profileError" class="form-error" role="alert"></p><button class="btn" type="submit">${bi('Сохранить профиль','Save profile')}</button></form><div class="actions">${user.role==='admin'?`<a class="btn outline small-btn" href="admin.html">${bi('Панель управления','Admin panel')}</a>`:''}<button class="btn outline small-btn" id="logout">${bi('Выйти','Sign out')}</button></div></div>`;return}
 $('#accountContent').innerHTML=`<p class="local-notice">${bi('Сайт можно смотреть без регистрации. Профиль нужен для отзывов, личного дневника и синхронизации между устройствами.','Explore without an account. Sign in for reviews, a private diary and syncing between devices.')}</p>${!serverOnline?`<p class="server-note">${bi('Сервер недоступен. Регистрация и общие отзывы заработают после его запуска.','Server unavailable. Registration and shared reviews need the server to be running.')}</p>`:''}<div class="auth-tabs"><button class="tab ${authMode==='register'?'active':''}" data-auth-mode="register">${bi('Регистрация','Register')}</button><button class="tab ${authMode==='login'?'active':''}" data-auth-mode="login">${bi('Войти','Sign in')}</button></div><form id="authForm" class="dialog-form">${authMode==='register'?`<label>${bi('Имя','Name')}<input name="name" required minlength="2" maxlength="40" autocomplete="nickname"></label><div class="actions"><div class="avatar-preview" id="avatarPreview">${icon('user')}</div><label>${bi('Аватарка (необязательно)','Avatar (optional)')}<input id="avatarFile" name="avatar" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG, JPG, WebP · ${bi('до 8 МБ','up to 8 MB')}</small></label></div>`:''}<label>Email<input name="email" type="email" required maxlength="120" autocomplete="email"></label><label>${bi('Пароль, минимум 8 символов','Password, at least 8 characters')}<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="${authMode==='register'?'new-password':'current-password'}"></label><p id="authError" class="form-error" role="alert"></p><button type="submit" class="btn terra">${bi(authMode==='register'?'Создать профиль':'Войти',authMode==='register'?'Create profile':'Sign in')}</button></form>`;
}
async function imageFile(file,{avatar=false,width=1200}={}){
 if(!file)return '';
 if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024)throw new Error(bi('Выберите PNG, JPG или WebP до 8 МБ.','Choose PNG, JPG or WebP up to 8 MB.'));
 const url=URL.createObjectURL(file);
 try{
  const img=new Image();img.src=url;await img.decode();
  if(img.width*img.height>45000000)throw new Error(bi('Слишком большое разрешение фотографии.','The image resolution is too large.'));
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
  if(avatar){canvas.width=canvas.height=160;const size=Math.min(img.width,img.height);context.fillStyle='#fff';context.fillRect(0,0,160,160);context.drawImage(img,(img.width-size)/2,(img.height-size)/2,size,size,0,0,160,160)}
  else{const scale=Math.min(1,width/Math.max(img.width,img.height));canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height)}
  let result=canvas.toDataURL('image/jpeg',.78);if(result.length>1300000)result=canvas.toDataURL('image/jpeg',.5);
  if(result.length>1350000)throw new Error(bi('Сожмите фотографию перед загрузкой.','Please compress the photo before uploading.'));
  return result;
 }catch(error){throw new Error(error.message||bi('Не удалось прочитать фотографию.','Could not read this photo.'))}finally{URL.revokeObjectURL(url)}
}
async function filePhotos(input){const files=[...(input?.files||[])];if(files.length>3)throw new Error(bi('Можно добавить до трёх фото.','Add up to three photos.'));return Promise.all(files.map(file=>imageFile(file)))}
async function formTask(form,errorSelector,task){const submit=form.querySelector('[type="submit"]');if(submit)submit.disabled=true;textAt(errorSelector,'');try{await task()}catch(error){textAt(errorSelector,error.message)}finally{if(submit)submit.disabled=false}}
async function submitAuth(form){await formTask(form,'#authError',async()=>{const data=new FormData(form),register=authMode==='register';const response=await api(register?'/api/register':'/api/login','POST',{email:data.get('email'),password:data.get('password'),...(register?{name:data.get('name'),avatar:await imageFile(data.get('avatar')?.size?data.get('avatar'):null,{avatar:true})}:{})});user=response.user;csrf=response.csrf;serverOnline=true;await loadState(register);$('#accountDialog').close();updateAccountButton();await Promise.all([refreshPrivate(),loadReviews()]);renderPage();const next=pendingAction;pendingAction=null;toast(bi('Вы вошли в профиль.','You are signed in.'));if(next)next()})}
async function logout(){
 try{clearTimeout(syncTimer);await syncQueue;if(user)await api('/api/state','POST',{...state,favorites:[...favorites],visited:[...visited]});await api('/api/logout','POST',{});user=null;csrf=null;diaryRows=[];suggestionRows=[];adminData=null;await loadState();renderAccount();renderPage();await loadReviews();updateAccountButton();toast(bi('Вы вышли из профиля.','Signed out.'))}catch(error){toast(error.message)}
}
function statusLabel(status){return bi({pending:'На модерации',approved:'Опубликовано',rejected:'Не одобрено',deleted:'Удалено'}[status]||status,{pending:'Pending review',approved:'Published',rejected:'Not approved',deleted:'Deleted'}[status]||status)}
function imageStrip(photos,large=false){return photos?.length?`<div class="photo-strip ${large?'large':''}">${photos.filter(safePhoto).map((src,i)=>`<button data-photo="${esc(src)}" aria-label="${bi('Открыть фотографию','Open photo')} ${i+1}"><img src="${esc(src)}" alt="${bi('Фотография путешественника','Traveller’s photo')} ${i+1}" loading="lazy"></button>`).join('')}</div>`:''}
function renderReviews(){
 if(!$('#reviewList'))return;
 const filter=$('#reviewFilter')?.value||'all';
 const rows=reviewRows.filter(r=>filter==='all'||r.place_id===filter);
 $('#reviewList').innerHTML=rows.length?rows.map(r=>{const p=byId(r.place_id);return `<article class="review-card"><div class="review-author"><div class="avatar">${avatarMarkup(r)}</div><div><strong>${esc(r.name)}</strong><small>${esc(p?nameOf(p):tr('brand'))} · ${r.rating} / 5 · ${prettyDate(r.created)}</small></div></div>${r.status!=='approved'?`<span class="status-tag ${r.status}">${statusLabel(r.status)}</span>`:''}<p>${esc(r.text)}</p>${imageStrip(r.photos)}${r.user_id===user?.id?`<button data-delete-review="${r.id}">${bi('Удалить мой отзыв','Delete my review')}</button>`:''}</article>`}).join(''):empty('Пока без отзывов','No reviews yet','Ваше впечатление может стать первым. Новые отзывы появятся после модерации.','Your experience could be the first. New reviews appear after moderation.');
}
async function loadReviews(){if(!$('#reviewList'))return;try{reviewRows=(await api('/api/reviews')).reviews;renderReviews()}catch(error){htmlAt('#reviewList',empty('Отзывы недоступны','Reviews unavailable',error.message,error.message))}}
function openReview(id='site'){requireAccount(()=>{reviewPlace=byId(id)?id:'site';$('#reviewPlace').innerHTML=`<option value="site">${tr('brand')}</option>`+PLACES.map(p=>`<option value="${p.id}">${esc(nameOf(p))}</option>`).join('');$('#reviewPlace').value=reviewPlace;textAt('#reviewError','');showDialog('#reviewDialog')})}
async function submitReview(form){await formTask(form,'#reviewError',async()=>{if(!user)throw new Error(bi('Войдите в профиль.','Please sign in.'));await api('/api/reviews','POST',{placeId:$('#reviewPlace').value,rating:Number($('#reviewRating').value),text:$('#reviewText').value.trim(),photos:await filePhotos($('#reviewPhotos'))});form.reset();$('#reviewDialog').close();await loadReviews();toast(bi('Отзыв отправлен на модерацию @baerovich.','Review sent to @baerovich for moderation.'))})}
function renderJournal(){
 if(!$('#journalPlaces'))return;
 $('#journalAccount').innerHTML=user?`<div class="avatar">${avatarMarkup(user)}</div><div><strong>${esc(user.name)}</strong><p id="syncStatus" class="sync-note">${bi('Сохранённые места синхронизируются с профилем.','Saved places sync with your account.')}</p></div><div class="actions"><button class="btn outline small-btn" data-open-account>${bi('Мой профиль','My profile')}</button></div>`:`<div><strong>${bi('Ваше путешествие уже началось','Your journey has already started')}</strong><p>${bi('Избранное и посещения пока на этом устройстве. Создайте профиль, чтобы сохранить их на сервере.','Saved places and visits are on this device. Create an account to store them on the server.')}</p></div><button class="btn small-btn" data-open-account>${bi('Создать профиль','Create profile')}</button>`;
 $('#tripStats').innerHTML=[[favorites.size,'Сохранено мест','Places saved'],[visited.size,'Посещено мест','Places visited'],[diaryRows.length,'Историй в дневнике','Diary entries']].map(([n,ru,en])=>`<div class="trip-stat"><strong>${n}</strong><span>${bi(ru,en)}</span></div>`).join('');
 const historyCount=[...visited].filter(id=>['fortress','gates','dostoevsky','vrubel','historymuseum','cathedral'].includes(id)).length;
 const parksCount=[...visited].map(byId).filter(p=>p&&/(парк|сад|гавань)/i.test(p.ru)).length;
 const achievements=[['compass','Первое открытие','First discovery','Посетите одно место','Visit one place',visited.size>=1],['culture','Знаток истории','History explorer','Отметьте три исторических места','Visit three historic places',historyCount>=3],['tree','Исследователь парков','Park explorer','Отметьте три парка или сада','Visit three parks or gardens',parksCount>=3],['quiz','Почти местный','Almost a local','Наберите 4 из 5 в викторине','Score 4 out of 5 in the quiz',state.quizScore>=4]];
 $('#badges').innerHTML=achievements.map(([ic,ru,en,sru,sen,earned])=>`<article class="badge-card ${earned?'earned':''}">${icon(ic)}<h3>${bi(ru,en)}</h3><p>${bi(sru,sen)}</p><span class="badge-state">${bi(earned?'Получено':'Впереди',earned?'Unlocked':'Still to discover')}</span></article>`).join('');
 const list=[...(journalTab==='favorites'?favorites:visited)].map(byId).filter(Boolean);$('#journalPlaces').innerHTML=list.length?list.map(card).join(''):empty('Здесь будут ваши места','Your places will appear here','Сохраняйте карточки сердечком и отмечайте посещения.','Tap a heart to save a place and mark your visits.');
 $$('[data-journal]').forEach(b=>{b.classList.toggle('active',b.dataset.journal===journalTab);b.setAttribute('aria-pressed',String(b.dataset.journal===journalTab))});
 $('#exportFavorites').disabled=!favorites.size;
 renderDiary();renderMySuggestions();
}
function renderDiary(){if(!$('#diaryList'))return;if(!user){$('#diaryList').innerHTML=empty('Ваши истории — только для вас','Your stories are just for you','Войдите в профиль, чтобы вести дневник с фотографиями.','Sign in to keep a diary with photos.');return}$('#diaryList').innerHTML=diaryRows.length?diaryRows.map(entry=>{const p=byId(entry.place_id);return `<article class="diary-entry"><small>${prettyDate(entry.visited+'T12:00:00+05:00')}</small><h3>${esc(p?nameOf(p):entry.place_id)}</h3><p>${esc(entry.text)}</p>${imageStrip(entry.photos,true)}<div class="actions"><button class="btn outline small-btn" data-edit-diary="${entry.id}">${bi('Редактировать','Edit')}</button><button class="btn outline small-btn" data-delete-diary="${entry.id}">${bi('Удалить','Delete')}</button></div></article>`}).join(''):empty('Сохраните первый день в городе','Save your first day in the city','Добавьте заметку и фотографии. Записи не публикуются.','Add a note and photos. Entries are private.')}
function openDiary(id){requireAccount(()=>{currentDiary=diaryRows.find(e=>e.id===id)||null;$('#diaryForm').reset();$('#diaryPlace').innerHTML=PLACES.map(p=>`<option value="${p.id}">${esc(nameOf(p))}</option>`).join('');const f=$('#diaryForm');f.elements.id.value=currentDiary?.id||'';f.elements.placeId.value=currentDiary?.place_id||PLACES[0].id;f.elements.visited.value=currentDiary?.visited||dateParts();f.elements.text.value=currentDiary?.text||'';textAt('#diaryError','');showDialog('#diaryDialog')})}
async function submitDiary(form){await formTask(form,'#diaryError',async()=>{const d=new FormData(form),uploads=await filePhotos($('#diaryPhotos'));await api('/api/diary','POST',{id:d.get('id'),placeId:d.get('placeId'),visited:d.get('visited'),text:d.get('text'),photos:uploads.length?uploads:(currentDiary?.photos||[])});$('#diaryDialog').close();await refreshPrivate();renderJournal();toast(bi('Запись сохранена.','Entry saved.'))})}
function renderMySuggestions(){if(!$('#mySuggestions'))return;$('#mySuggestions').innerHTML=user?(suggestionRows.length?suggestionRows.map(s=>`<article class="review-card"><span class="status-tag ${s.status}">${statusLabel(s.status)}</span><h3>${esc(s.payload.name)}</h3><p>${esc(s.payload.address)}</p></article>`).join(''):empty('Поделитесь своим открытием','Share a discovery','Предложите место, которого пока нет в каталоге.','Suggest somewhere missing from the catalogue.')):empty('Предложения — из вашего профиля','Suggestions from your profile','Войдите, чтобы предложить место и следить за его статусом.','Sign in to suggest a place and track its status.')}
function openSuggestion(){requireAccount(()=>{$('#suggestionForm').reset();$('#suggestCategory').innerHTML=CATEGORIES.slice(1).map(([id,ic,ru,en])=>`<option value="${id}">${bi(ru,en)}</option>`).join('');textAt('#suggestionError','');showDialog('#suggestionDialog')})}
async function submitSuggestion(form){await formTask(form,'#suggestionError',async()=>{const data=Object.fromEntries(new FormData(form));data.photo=await imageFile($('#suggestPhoto').files[0]);await api('/api/suggestions','POST',data);$('#suggestionDialog').close();await refreshPrivate();renderMySuggestions();toast(bi('Предложение отправлено администратору.','Suggestion sent to the administrator.'))})}
async function refreshPrivate(){if(!user){diaryRows=[];suggestionRows=[];return}const responses=await Promise.allSettled([api('/api/diary'),api('/api/suggestions')]);if(responses[0].status==='fulfilled')diaryRows=responses[0].value.entries;if(responses[1].status==='fulfilled')suggestionRows=responses[1].value.suggestions;responses.filter(r=>r.status==='rejected').forEach(r=>toast(r.reason.message));if(page==='admin')await loadAdmin()}

function checklistItems(){const common=[['phone','Заряженный телефон и пауэрбанк','Charged phone and power bank'],['shoes','Удобная обувь','Comfortable shoes'],['water','Бутылка воды','A bottle of water'],['addresses','Сохранённые адреса и маршрут','Saved addresses and route']];const seasonal=[['layers','Тёплые слои и термобельё','Warm layers and thermals'],['raincoat','Зонт или дождевик','Umbrella or raincoat'],['sun','Головной убор и солнцезащита','Hat and sun protection'],['wind','Ветровка и непромокаемая обувь','Windproof jacket and waterproof shoes']];return [...common,seasonal[season],...(season===0?[['gloves','Варежки и нескользкая подошва','Mittens and non-slip soles']]:[])]}
function renderChecklist(){htmlAt('#checklist',checklistItems().map(([key,ru,en])=>`<label class="check-item"><input type="checkbox" data-checklist="${key}" ${state.checklist.includes(key)?'checked':''}><span>${bi(ru,en)}</span></label>`).join(''))}
function speechText(p){const extras={fortress:bi('Омская крепость связана с историей города и сибирскими годами Достоевского. Прогуляйтесь по историческому центру и сравните старые ворота с современными улицами.','Omsk Fortress is linked to the city’s history and Dostoevsky’s Siberian years. Explore the historic centre and see old gates alongside modern streets.'),dostoevsky:bi('Достоевский находился в Омском остроге с 1850 по 1854 год. Эти годы отразились в книге «Записки из Мёртвого дома».','Dostoevsky was imprisoned in Omsk from 1850 to 1854. These years informed Notes from a Dead House.'),vrubel:bi('Михаил Врубель родился в Омске. Музей носит его имя. Обратите внимание: картина «Демон сидящий» хранится в Третьяковской галерее в Москве.','Mikhail Vrubel was born in Omsk. The museum bears his name. His painting Demon Seated is held by the Tretyakov Gallery in Moscow.'),drama:bi('История Омского театра драмы начинается в 1874 году. Перед вечерним спектаклем проверьте афишу и наличие билетов.','The Omsk Drama Theatre dates back to 1874. Check the programme and tickets before an evening visit.')};return nameOf(p)+'. '+bi(p.descRu,p.descEn)+' '+(extras[p.id]||'')}
function renderVoices(){if(!$('#audioVoice'))return;if(!('speechSynthesis'in window)){$('#playAudio').disabled=true;textAt('#audioStatus',bi('Этот браузер не поддерживает озвучивание.','This browser does not support text-to-speech.'));return}voices=speechSynthesis.getVoices();const locale=lang==='ru'?'ru':'en';$('#audioVoice').innerHTML=`<option value="">${bi('Автоматический выбор','Automatic voice')}</option>`+voices.map((v,i)=>({v,i})).filter(({v})=>v.lang.startsWith(locale)).map(({v,i})=>`<option value="${i}">${esc(v.name)} (${esc(v.lang)})</option>`).join('')}
function playAudio(id){const p=byId(id||$('#audioPlace')?.value);if(!p)return;if(!('speechSynthesis'in window)){toast(bi('Браузер не поддерживает озвучку.','Your browser does not support speech.'));return}speechSynthesis.cancel();utterance=new SpeechSynthesisUtterance(speechText(p));utterance.lang=lang==='ru'?'ru-RU':'en-GB';const voiceIndex=$('#audioVoice')?.value;if(voiceIndex!==''&&voiceIndex!==undefined&&voices[Number(voiceIndex)])utterance.voice=voices[Number(voiceIndex)];utterance.rate=.94;utterance.onstart=()=>textAt('#audioStatus',bi('Сейчас звучит: ','Playing: ')+nameOf(p));utterance.onend=()=>textAt('#audioStatus',bi('История закончилась. Выберите следующую.','Story finished. Choose another.'));utterance.onerror=()=>textAt('#audioStatus',bi('Озвучивание прервано или голос недоступен.','Speech was interrupted or the voice is unavailable.'));speechSynthesis.speak(utterance);if(!$('#audioStatus'))toast(bi('Аудиогид: ','Audio guide: ')+nameOf(p))}
function weatherDescription(code){return code===0?bi('Ясно','Clear'):code<=3?bi('Облачно','Cloudy'):code<=48?bi('Туман','Fog'):code<=67?bi('Дождь','Rain'):code<=77?bi('Снег','Snow'):code<=82?bi('Ливни','Rain showers'):code<=86?bi('Снегопад','Snow showers'):bi('Гроза','Thunderstorm')}
function weatherAdvice(c){if(c.apparent_temperature<=-15)return bi('Морозно: сократите прогулку, оденьтесь слоями и добавьте тёплую остановку.','Very cold: keep walks short, wear layers and add an indoor stop.');if(c.precipitation>0||c.weather_code>=51)return bi('Возможны осадки. Возьмите зонт или дождевик; для маршрута есть план в помещениях.','Precipitation is possible. Bring an umbrella or raincoat; try the indoor route.');if(c.apparent_temperature<=5)return bi('Прохладно: наденьте тёплую куртку и закрытую обувь. Добавьте остановку в кафе или музее.','Chilly: wear a warm jacket and closed shoes. Add a café or museum stop.');if(c.wind_speed_10m>=30)return bi('Ветрено. На набережной холоднее по ощущениям; возьмите ветровку.','Windy. The riverside may feel colder; bring a windproof layer.');if(c.temperature_2m>=28)return bi('Жарко: вода, головной убор и прогулка утром или вечером.','Hot: take water and a hat; walk in the morning or evening.');return bi('Подходящее время для прогулки. Возьмите удобную обувь и лёгкий дополнительный слой.','A good time for a walk. Wear comfortable shoes and bring an extra light layer.')}
function renderWeather(){if(!weatherData)return;const c=weatherData.current;$$('[data-weather]').forEach(el=>el.innerHTML=`<div class="weather-main"><strong class="weather-temp">${Math.round(c.temperature_2m)>0?'+':''}${Math.round(c.temperature_2m)} °C</strong><div class="weather-meta">${weatherDescription(c.weather_code)}<br>${bi('Ощущается как','Feels like')} ${Math.round(c.apparent_temperature)} °C<br>${bi('Ветер','Wind')} ${Math.round(c.wind_speed_10m)} ${bi('км/ч','km/h')}</div></div><div class="weather-advice">${weatherAdvice(c)}</div><p class="small">${weatherData.stale?bi('Сохранённые данные. Обновить пока не удалось. ','Cached data. Refresh is unavailable. '):''}${bi('Обновлено: ','Updated: ')}${prettyDate(weatherData.updated,true)} · UTC+5</p><a class="text-link" href="routes.html?mood=rain">${bi('Открыть план на дождь','Explore the rainy-day plan')}${icon('arrowRight')}</a>`)}
async function loadWeather(){if(!$$('[data-weather]').length)return;try{weatherData=await api('/api/weather');renderWeather()}catch(error){$$('[data-weather]').forEach(el=>el.innerHTML=`<p>${esc(error.message)}</p><button class="retry-weather" data-retry-weather>${bi('Попробовать ещё раз','Try again')}</button>`)}}
function renderEvents(){
 if(!$('#eventList')||!eventData)return;
 const from=$('#eventFrom').value,to=$('#eventTo').value,tz=$('#eventTimezone').value;
 const rows=eventData.events.filter(event=>{const day=dateParts(new Date(event.date),tz);return (!from||day>=from)&&(!to||day<=to)});
 textAt('#eventStatus',(eventData.stale?bi('Не удалось обновить источник. Показано сохранённое расписание. ','Source refresh failed. Showing the saved schedule. '):'')+(eventData.updated?bi('Источник обновлён: ','Source updated: ')+prettyDate(eventData.updated,true):bi('Расписание источника пока недоступно.','Source schedule is unavailable.')));
 $('#eventList').innerHTML=rows.length?rows.map(event=>`<article class="event-card"><div class="event-date">${prettyDate(event.date,true,tz)} · ${tz==='Asia/Omsk'?'UTC+6':'UTC+5'}</div><h3>${esc(bi(event.title,event.titleEn))}</h3><p>${esc(bi(event.venue,event.venueEn))}</p><p>${esc(bi(event.description,event.descriptionEn))}</p><div class="event-foot"><span class="pill">${event.price===null?bi('Цена у организатора','Price from organiser'):event.price+' ₽'}</span>${event.url?`<a class="text-link" href="${esc(event.url)}" target="_blank" rel="noopener">${bi('Подробнее у организатора','More from the organiser')}${icon('arrowUpRight')}</a>`:''}${event.source?`<a class="small" href="${esc(event.source)}" target="_blank" rel="noopener">${bi('Источник расписания','Schedule source')}</a>`:''}</div></article>`).join(''):empty('Пока нет событий на эти даты','No events on these dates','Выберите другой период или откройте официальную афишу ниже.','Choose another period or open an official programme below.');
}
async function loadEvents(){if(!$('#eventList'))return;htmlAt('#eventList',empty('Загружаем афишу','Loading events'));try{eventData=await api('/api/events');renderEvents()}catch(error){textAt('#eventStatus',error.message);htmlAt('#eventList',empty('Расписание временно недоступно','Schedule temporarily unavailable','Откройте официальный сайт театра по ссылке ниже.','Use the official theatre link below.'))}}

async function loadAdmin(){
 if(!$('#adminWorkspace'))return;
 if(!user||user.role!=='admin'){$('#adminWorkspace').hidden=true;$('#adminGate').innerHTML=`<div class="panel admin-lock"><h2>${bi('Только для администратора','For the administrator')}</h2><p>${bi('Управление каталогом и модерация доступны из административной учётной записи. Контакт проекта — @baerovich.','Catalogue management and moderation require an administrator account. Project contact: @baerovich.')}</p><button class="btn" data-admin-login>${bi('Войти администратором','Administrator sign-in')}</button></div>`;return}
 try{adminData=await api('/api/admin');$('#adminWorkspace').hidden=false;$('#adminGate').innerHTML='';
  const selected=$('#editPlaceSelect').value;$('#editPlaceSelect').innerHTML=adminData.places.map(p=>`<option value="${p.id}">${esc(nameOf(p))}</option>`).join('');if(selected&&byId(selected))$('#editPlaceSelect').value=selected;
  if(!editorPlace)fillPlaceEditor(adminData.places[0]);
  renderModeration();
 }catch(error){htmlAt('#adminGate',empty('Панель недоступна','Panel unavailable',error.message,error.message));$('#adminWorkspace').hidden=true}
}
function renderModeration(){if(!adminData)return;
 $('#adminReviews').innerHTML=adminData.reviews.length?adminData.reviews.map(r=>`<article class="moderation-card"><span class="status-tag ${r.status}">${statusLabel(r.status)}</span><h3>${esc(byId(r.place_id)?nameOf(byId(r.place_id)):tr('brand'))}</h3><div class="review-author"><div class="avatar">${avatarMarkup(r)}</div><strong>${esc(r.name)} · ${r.rating} / 5</strong></div><p>${esc(r.text)}</p>${imageStrip(r.photos)}<div class="actions"><button class="btn small-btn" data-moderate-review="${r.id}" data-status="approved">${bi('Опубликовать','Publish')}</button><button class="btn outline small-btn" data-moderate-review="${r.id}" data-status="rejected">${bi('Отклонить','Reject')}</button><button class="btn outline small-btn" data-moderate-review="${r.id}" data-status="pending">${bi('На проверку','Pending')}</button></div></article>`).join(''):empty('Отзывов на проверку пока нет','No reviews to moderate');
 $('#adminSuggestions').innerHTML=adminData.suggestions.length?adminData.suggestions.map(s=>`<article class="moderation-card"><span class="status-tag ${s.status}">${statusLabel(s.status)}</span><h3>${esc(s.payload.name)}</h3><small>${esc(s.name)} · ${esc(s.payload.address)}</small><p>${esc(s.payload.description)}</p>${s.payload.url?`<a class="text-link" href="${esc(s.payload.url)}" target="_blank" rel="noopener">${bi('Ссылка автора','Suggested link')}</a>`:''}${imageStrip(s.payload.photo?[s.payload.photo]:[])}<div class="actions">${s.status==='pending'?`<button class="btn small-btn" data-moderate-suggestion="${s.id}" data-status="approved">${bi('Одобрить и добавить в каталог','Approve and add to catalogue')}</button><button class="btn outline small-btn" data-moderate-suggestion="${s.id}" data-status="rejected">${bi('Отклонить','Reject')}</button>`:''}</div></article>`).join(''):empty('Предложений пока нет','No suggestions yet');
 $('#adminEvents').innerHTML=adminData.events.length?adminData.events.map(e=>`<article class="moderation-card"><small>${prettyDate(e.date,true,'Asia/Omsk')} · UTC+6</small><h3>${esc(bi(e.title,e.titleEn))}</h3><p>${esc(bi(e.venue,e.venueEn))}</p><div class="actions"><button class="btn outline small-btn" data-edit-event="${e.id}">${bi('Редактировать','Edit')}</button><button class="btn outline small-btn" data-archive-event="${e.id}">${bi('В архив','Archive')}</button></div></article>`).join(''):empty('Добавьте своё событие','Add your own event','Афиша театра обновляется отдельно, автоматически.','Theatre listings update separately and automatically.');
}
function fillPlaceEditor(p){
 const form=$('#placeEditor');if(!form)return;
 editorPlace=p?{...p}:null;form.reset();form.elements.id.readOnly=Boolean(p);
 for(const key of ['id','ru','en','descRu','descEn','price','rating','minutes','tags','lat','lng'])form.elements[key].value=p?.[key]??(key==='minutes'?50:'');
 form.elements.category.value=p?.cats[0]||'walk';form.elements.extraCategory.value=p?.cats[1]||'';
 form.elements.indoor.checked=p?.indoor||false;form.elements.photo.value=p?.photo?.startsWith('https://')?p.photo:'';textAt('#placeEditorError','');
}
async function submitPlace(form){await formTask(form,'#placeEditorError',async()=>{
 const d=Object.fromEntries(new FormData(form));const cats=[...new Set([d.category,d.extraCategory].filter(Boolean))];
 let photoURL=d.photo||editorPlace?.photo||'';if($('#editorPhoto').files.length)photoURL=await imageFile($('#editorPhoto').files[0]);
 const place={id:d.id,ru:d.ru,en:d.en,descRu:d.descRu,descEn:d.descEn,cats,price:Number(d.price),rating:Number(d.rating),minutes:Number(d.minutes),lat:d.lat===''?null:Number(d.lat),lng:d.lng===''?null:Number(d.lng),indoor:form.elements.indoor.checked,tags:d.tags,photo:photoURL,image:editorPlace?.image||cats[0]};
 const response=await api('/api/admin/place','POST',place);const index=PLACES.findIndex(p=>p.id===response.place.id);if(index>=0)PLACES[index]=response.place;else PLACES.push(response.place);
 fillPlaceEditor(response.place);await loadAdmin();$('#editPlaceSelect').value=response.place.id;toast(bi('Место сохранено и доступно в каталоге.','Place saved and available in the catalogue.'));
 })}
function fillEventEditor(event){const form=$('#eventEditor');form.reset();if(!event)return;for(const key of ['id','title','titleEn','venue','venueEn','description','descriptionEn','url','source','price'])form.elements[key].value=event[key]??'';const date=new Date(event.date),parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Omsk',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));form.elements.date.value=`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`}
async function submitEvent(form){await formTask(form,'#eventEditorError',async()=>{const d=Object.fromEntries(new FormData(form));d.price=d.price===''?null:Number(d.price);d.date=d.date+':00+06:00';await api('/api/admin/event','POST',d);form.reset();await loadAdmin();toast(bi('Событие сохранено в афише.','Event saved to the programme.'))})}

let theme=read('theme',window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light');if(!['light','dark'].includes(theme))theme='light';
let large=read('large',false);
function applyTheme(){document.documentElement.dataset.theme=theme;$('#themeToggle').innerHTML=icon(theme==='light'?'moon':'sun');$('meta[name="theme-color"]').content=theme==='light'?'#f6f3ec':'#192520'}
function applyLarge(){document.documentElement.dataset.large=String(large);['#largeToggle','#largeModePage'].forEach(sel=>{if($(sel)){$(sel).setAttribute('aria-pressed',String(large));$(sel).setAttribute('aria-label',bi('Крупный интерфейс','Larger interface'))}});save('large',large);if(map)setTimeout(()=>map.invalidateSize(),100)}
function renderPage(){
 hydrate();document.documentElement.lang=lang;document.title=bi(document.body.dataset.titleRu,document.body.dataset.titleEn)+' — '+tr('brand');
 $$('[data-lang]').forEach(b=>{b.classList.toggle('active',b.dataset.lang===lang);b.setAttribute('aria-pressed',String(b.dataset.lang===lang))});
 $$('[data-page-link]').forEach(a=>{if(a.dataset.pageLink===page)a.setAttribute('aria-current','page')});
 $('#nav').setAttribute('aria-label',bi('Навигация','Navigation'));$('#favoritesNav').setAttribute('aria-label',tr('myFav'));
 if($('#heroPhoto')){$('#heroPhoto').src=PHOTOS.river;$('#heroPhoto').alt=bi('Река Иртыш в Омске','Irtysh River in Omsk')}
 if($('.telegram-card'))$('.telegram-card').setAttribute('aria-label',bi('Пример диалога с ботом','Illustrative bot conversation'));
 if($('.header-telegram'))$('.header-telegram').setAttribute('aria-label',tr('openTelegram'));
 if($('#capabilities')){renderCapabilities();$$('#capabilities a').forEach(a=>{const f=a.dataset.feature;const destinations={places:'places.html',random:'places.html?random=1',top:'places.html?top=1',routes:'routes.html',favorites:'journal.html#saved',search:'places.html?search=1',how:'about.html#how',quiz:'guide.html#quiz',seasons:'guide.html#seasons',language:'about.html'};a.href=destinations[f]||'places.html';if(a.dataset.cat)a.href+='?category='+a.dataset.cat})}
 if($('#categoryTabs')){renderCategories();$('#categoryTabs').setAttribute('aria-label',bi('Категории','Categories'));filterPlaces()}
 if($('#galleryGrid'))renderGallery();
 if($('#timeline'))renderRoutes();
 if($('#seasonContent')){renderSeason();renderChecklist()}
 if($('#quizContent'))renderQuiz();
 if($('#factContent'))renderFact();
 if($('#audioPlace')){const selected=$('#audioPlace').value;$('#audioPlace').innerHTML=PLACES.map(p=>`<option value="${p.id}">${esc(nameOf(p))}</option>`).join('');if(byId(selected))$('#audioPlace').value=selected;renderVoices()}
 if($('#reviewFilter')){const old=$('#reviewFilter').value;$('#reviewFilter').innerHTML=`<option value="all">${bi('Все отзывы','All reviews')}</option><option value="site">${tr('brand')}</option>`+PLACES.map(p=>`<option value="${p.id}">${esc(nameOf(p))}</option>`).join('');$('#reviewFilter').value=old||'all';renderReviews()}
 renderJournal();renderWeather();renderEvents();updateCounters();updateAccountButton();applyTheme();applyLarge();
 if($('#accountDialog').open)renderAccount();
 if($('#compareDialog').open)renderComparison();
 if($('#adminWorkspace')&&adminData)renderModeration();
 if(page==='admin'&&user?.role!=='admin')loadAdmin();
 if($('#reviewDialog').open){const selected=$('#reviewPlace').value;$('#reviewPlace').innerHTML=`<option value="site">${tr('brand')}</option>`+PLACES.map(p=>`<option value="${p.id}">${esc(nameOf(p))}</option>`).join('');$('#reviewPlace').value=selected}
 // Photos and third-party titles keep their author's language; interface controls are translated.
 if($('#eventTimezone')){$('#eventTimezone option[value="Asia/Qyzylorda"]').textContent=bi('Кызылорда · UTC+5','Qyzylorda · UTC+5');$('#eventTimezone option[value="Asia/Omsk"]').textContent=bi('Омск · UTC+6','Omsk · UTC+6')}
 if($('#editPlaceSelect'))$('#editPlaceSelect').setAttribute('aria-label',bi('Выбрать место','Choose a place'));
 $$('img[src="assets/telegram-qr.png"]').forEach(img=>img.alt=bi('QR-код Telegram-бота @OmskGuide55_Bot','Telegram QR code for @OmskGuide55_Bot'));
}
async function handleAction(b,event){
 if(b.hasAttribute('data-close'))b.closest('dialog').close();
 if(b.dataset.lang){lang=b.dataset.lang;save('lang',lang);if('speechSynthesis'in window)speechSynthesis.cancel();renderPage();return}
 if(b.dataset.category){category=b.dataset.category;shown=9;renderCategories();filterPlaces()}
 if(b.dataset.favorite){const id=b.dataset.favorite;favorites.has(id)?favorites.delete(id):favorites.add(id);persistState();renderCards();renderJournal();if($('#randomDialog').open){const p=byId($('#randomContent [data-favorite]')?.dataset.favorite);if(p)$('#randomContent').innerHTML=card(p)}}
 if(b.dataset.visited){const id=b.dataset.visited;visited.has(id)?visited.delete(id):visited.add(id);persistState();renderCards();renderJournal();if($('#randomDialog').open){const p=byId($('#randomContent [data-visited]')?.dataset.visited);if(p)$('#randomContent').innerHTML=card(p)}}
 if(b.dataset.compare){const id=b.dataset.compare;if(compareSet.has(id))compareSet.delete(id);else if(compareSet.size<4)compareSet.add(id);else{toast(bi('Сравнивайте не более четырёх мест.','Compare up to four places.'));return}save('compare',[...compareSet]);renderCards();renderJournal();updateCompareBar();if(!$('#compareBar')&&compareSet.size>=2){renderComparison();showDialog('#compareDialog')}}
 if(b.dataset.audio)playAudio(b.dataset.audio);
 if(b.dataset.review){if($('#randomDialog').open)$('#randomDialog').close();openReview(b.dataset.review)}
 if(b.dataset.route!==undefined){routeIndex=Number(b.dataset.route);customRoute=null;beforeRain=null;renderRoutes()}
 if(b.dataset.quick)buildQuick(Number(b.dataset.quick));
 if(b.dataset.mood)moodRoute(b.dataset.mood);
 if(b.dataset.season!==undefined){season=Number(b.dataset.season);renderSeason();renderChecklist()}
 if(b.dataset.answer!==undefined)showQuizAnswer(Number(b.dataset.answer));
 if(b.id==='nextQuestion'){quizIndex++;quizAnswered=false;if(quizIndex===5){state.quizScore=Math.max(state.quizScore,quizScore);persistState()}renderQuiz()}
 if(b.id==='restartQuiz'){quizIndex=0;quizScore=0;quizAnswered=false;renderQuiz()}
 if(b.dataset.authMode){authMode=b.dataset.authMode;avatarDraft='';renderAccount()}
 if(b.hasAttribute('data-open-account')||b.hasAttribute('data-admin-login')){pendingAction=null;authMode=b.hasAttribute('data-admin-login')?'login':'register';renderAccount();showDialog('#accountDialog')}
 if(b.id==='logout')await logout();
 if(b.dataset.deleteReview){await api('/api/reviews/delete','POST',{id:b.dataset.deleteReview});await loadReviews()}
 if(b.dataset.journal){journalTab=b.dataset.journal;renderJournal()}
 if(b.dataset.editDiary)openDiary(b.dataset.editDiary);
 if(b.dataset.deleteDiary){await api('/api/diary/delete','POST',{id:b.dataset.deleteDiary});await refreshPrivate();renderJournal()}
 if(b.hasAttribute('data-retry-weather'))await loadWeather();
 if(b.dataset.gallery!==undefined){const g=GALLERY[Number(b.dataset.gallery)],label=bi(g[1],g[2]);$('#lightboxTitle').textContent=label;$('#lightboxImage').src=PHOTOS[g[3]]||placeholder(g[3],label);$('#lightboxImage').alt=label;textAt('#lightboxCaption',PHOTOS[g[3]]?bi('Источник и лицензия указаны в подвале.','Source and licence are listed in the footer.'):bi('Подписанная заглушка для вашей фотографии.','Labelled placeholder for your own photograph.'));showDialog('#lightbox')}
 if(b.dataset.photo&&safePhoto(b.dataset.photo)){textAt('#lightboxTitle',bi('Впечатление путешественника','A traveller’s impression'));$('#lightboxImage').src=b.dataset.photo;$('#lightboxImage').alt=bi('Фотография путешественника','Traveller’s photo');textAt('#lightboxCaption','');showDialog('#lightbox')}
 if(b.dataset.adminTab){$$('[data-admin-tab]').forEach(t=>{t.classList.toggle('active',t===b);t.setAttribute('aria-pressed',String(t===b))});$$('[data-admin-panel]').forEach(p=>p.hidden=p.dataset.adminPanel!==b.dataset.adminTab)}
 if(b.dataset.moderateReview){await api('/api/admin/review','POST',{id:b.dataset.moderateReview,status:b.dataset.status});await loadAdmin();toast(bi('Статус отзыва изменён.','Review status updated.'))}
 if(b.dataset.moderateSuggestion){await api('/api/admin/suggestion','POST',{id:b.dataset.moderateSuggestion,status:b.dataset.status});PLACES=(await api('/api/places')).places;await loadAdmin();toast(bi('Предложение рассмотрено.','Suggestion reviewed.'))}
 if(b.dataset.editEvent){fillEventEditor(adminData.events.find(e=>e.id===b.dataset.editEvent));$('#eventEditor').scrollIntoView({block:'center'})}
 if(b.dataset.archiveEvent){await api('/api/admin/event/archive','POST',{id:b.dataset.archiveEvent});await loadAdmin()}
}
document.addEventListener('click',event=>{const b=event.target.closest('button,a');if(b)handleAction(b,event).catch(error=>toast(error.message))});
document.addEventListener('submit',event=>{
 const form=event.target;
 const handlers={authForm:submitAuth,reviewForm:submitReview,diaryForm:submitDiary,suggestionForm:submitSuggestion,placeEditor:submitPlace,eventEditor:submitEvent};
 if(handlers[form.id]){event.preventDefault();handlers[form.id](form);return}
 if(form.id==='profileForm'){event.preventDefault();formTask(form,'#profileError',async()=>{const d=new FormData(form),file=d.get('avatar');const response=await api('/api/profile','POST',{name:d.get('name'),avatar:file?.size?await imageFile(file,{avatar:true}):user.avatar});user=response.user;renderAccount();renderPage();await loadReviews();toast(bi('Профиль обновлён.','Profile updated.'))})}
});
document.addEventListener('change',event=>{
 const el=event.target;
 if(el.dataset.checklist){state.checklist=el.checked?[...new Set([...state.checklist,el.dataset.checklist])]:state.checklist.filter(key=>key!==el.dataset.checklist);persistState()}
 if(el.id==='avatarFile'&&el.files[0]){imageFile(el.files[0],{avatar:true}).then(src=>{avatarDraft=src;htmlAt('#avatarPreview',`<img src="${src}" alt="${bi('Предпросмотр аватара','Avatar preview')}">`)}).catch(error=>textAt('#authError',error.message))}
});
on('#accountButton','click',()=>{pendingAction=null;renderAccount();showDialog('#accountDialog')});
on('#themeToggle','click',()=>{theme=theme==='light'?'dark':'light';save('theme',theme);applyTheme()});
['#largeToggle','#largeModePage'].forEach(sel=>on(sel,'click',()=>{large=!large;applyLarge()}));
on('#menuToggle','click',()=>{const open=$('#nav').classList.toggle('open');$('#menuToggle').setAttribute('aria-expanded',String(open))});
on('#search','input',()=>{shown=9;filterPlaces()});['#budgetFilter','#ratingFilter','#sortFilter'].forEach(sel=>on(sel,'change',()=>{shown=9;filterPlaces()}));
on('#resetFilters','click',resetFilters);on('#loadMore','click',()=>{shown+=9;renderCards()});on('#topTen','click',()=>{topOnly=!topOnly;shown=10;filterPlaces()});
on('#randomButton','click',randomPlace);on('#randomAgain','click',randomPlace);
on('#fitMap','click',()=>{if(!map)return toast(tr('mapError'));if(markers.getLayers().length)map.fitBounds(markers.getBounds(),{padding:[35,35],maxZoom:15});else toast(bi('Для этой подборки нет координат. Используйте 2ГИС.','No coordinates for this selection. Use 2GIS.'))});
on('#openCompare','click',()=>{renderComparison();showDialog('#compareDialog')});on('#clearCompare','click',()=>{compareSet.clear();save('compare',[]);renderCards();updateCompareBar()});
on('#builder','submit',event=>{event.preventDefault();const interests=$$('#builder [name=interest]:checked').map(el=>el.value);if(!interests.length)return textAt('#builderStatus',bi('Выберите хотя бы один интерес.','Choose at least one interest.'));const pools={nature:['birds','green','embankment','strelka'],history:['fortress','gates','dostoevsky','cathedral'],food:['skuratov','dumplings','peppers','kitchen'],family:['joule','youth','green','circus']};const hours=Number($('#duration').value),count=hours===3?3:hours===5?4:6,ids=[];for(let i=0;ids.length<count&&i<4;i++)for(const interest of interests){const id=pools[interest][i];if(byId(id)&&!ids.includes(id)&&ids.length<count)ids.push(id)}setRoute(ids,hours,'Ваш маршрут','Your route');textAt('#builderStatus',bi('Готово. Проверьте переезды и расписание в 2ГИС.','Ready. Check travel and opening hours on 2GIS.'))});
on('#rainRoute','click',toggleRain);['#people','#transport'].forEach(sel=>on(sel,'input',renderBudget));
on('#shareRoute','click',()=>copy(routeURL()));on('#routeQR','click',showQR);on('#downloadQR','click',()=>download('omsk-route-qr.svg',qrSVG,'image/svg+xml'));on('#exportRoute','click',()=>download('omsk-route.txt',routeText()));on('#printRoute','click',()=>window.print());
on('#prevFact','click',()=>{factIndex=(factIndex-1+FACTS.length)%FACTS.length;renderFact()});on('#nextFact','click',()=>{factIndex=(factIndex+1)%FACTS.length;renderFact()});
on('#copyChecklist','click',()=>copy(checklistItems().map(([key,ru,en])=>`[${state.checklist.includes(key)?'x':' '}] ${bi(ru,en)}`).join('\n')));on('#resetChecklist','click',()=>{state.checklist=[];persistState();renderChecklist()});
on('#playAudio','click',()=>playAudio());on('#pauseAudio','click',()=>{if(!('speechSynthesis'in window))return;speechSynthesis.paused?speechSynthesis.resume():speechSynthesis.pause()});on('#stopAudio','click',()=>{if('speechSynthesis'in window)speechSynthesis.cancel();textAt('#audioStatus',bi('Остановлено.','Stopped.'))});
on('#writeReview','click',()=>openReview());on('#reviewFilter','change',renderReviews);
on('#newDiary','click',()=>openDiary());on('#exportDiary','click',()=>{if(!user)return requireAccount(()=>{});download('omsk-diary.json',JSON.stringify(diaryRows,null,2),'application/json')});
on('#exportFavorites','click',()=>download('omsk-favorites.txt',tr('myFav')+'\n\n'+[...favorites].map(byId).filter(Boolean).map(p=>nameOf(p)+'\n'+gis(p)).join('\n\n')));
on('#suggestPlace','click',openSuggestion);on('#editPlaceSelect','change',()=>fillPlaceEditor(PLACES.find(p=>p.id===$('#editPlaceSelect').value)));on('#newPlace','click',()=>fillPlaceEditor(null));
on('#exportCatalog','click',()=>download('omsk-places.json',JSON.stringify(PLACES,null,2),'application/json'));on('#newEvent','click',()=>fillEventEditor(null));
['#eventFrom','#eventTo','#eventTimezone'].forEach(sel=>on(sel,'change',renderEvents));on('#resetEvents','click',()=>{$('#eventFrom').value='';$('#eventTo').value='';renderEvents()});
on('#copyContacts','click',()=>copy(tr('brand')+'\n\n'+BOT_URL+'\n'+bi('Администратор','Administrator')+': '+ADMIN_URL+'\n2GIS: https://2gis.ru/omsk\n'+bi('Погода','Weather')+': https://www.meteoinfo.ru/forecasts/russia/omsk-area/omsk\n'+bi('Аэропорт','Airport')+': https://oms.aero\n'+bi('Поезда','Trains')+': https://www.rzd.ru\n'+bi('Музей Врубеля','Vrubel Museum')+': https://vrubel.ru'));
on('#backTop','click',()=>window.scrollTo({top:0,behavior:'smooth'}));
window.addEventListener('scroll',()=>$('#backTop').hidden=window.scrollY<700,{passive:true});
window.addEventListener('hashchange',()=>{if(page==='routes')restoreRoute()});
window.addEventListener('beforeunload',()=>{if('speechSynthesis'in window)speechSynthesis.cancel()});
if('speechSynthesis'in window)speechSynthesis.addEventListener('voiceschanged',renderVoices);
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close()}}));
document.addEventListener('error',event=>{if(event.target instanceof HTMLImageElement&&!event.target.dataset.fallback){event.target.dataset.fallback='1';event.target.src=placeholder('walk',bi('Фотография недоступна','Photo unavailable'));event.target.alt=bi('Изображение недоступно; показана заглушка','Image unavailable; showing a placeholder')}},true);

async function boot(){
 const query=new URLSearchParams(location.search);if(CATEGORIES.some(c=>c[0]===query.get('category')))category=query.get('category');topOnly=query.has('top');
 renderPage();
 // Every page works as a genuine document with its own URL and content.
 const results=await Promise.allSettled([api('/api/places'),api('/api/session')]);
 if(results[0].status==='fulfilled')PLACES=results[0].value.places;
 if(results[1].status==='fulfilled'){user=results[1].value.user;csrf=results[1].value.csrf;serverOnline=true}
 try{await loadState()}catch(error){toast(error.message)}
 renderPage();
 if(page==='routes'){restoreRoute();if(query.has('mood'))moodRoute(query.get('mood'))}
 if($('#map'))initMap();
 if(query.has('random')&&page==='places')randomPlace();
 if(query.has('search')&&$('#search'))$('#search').focus();
 await Promise.allSettled([refreshPrivate(),loadReviews(),loadWeather(),loadEvents()]);renderJournal();
}
// Keep appearance changes immediate while the server connection is being checked.
renderPage();
if('IntersectionObserver'in window){const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target)}}),{threshold:.06});$$('.reveal').forEach(el=>observer.observe(el))}else $$('.reveal').forEach(el=>el.classList.add('visible'));
boot().catch(error=>toast(error.message));
