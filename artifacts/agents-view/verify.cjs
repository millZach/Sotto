const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
 const browser = await chromium.launch({headless:true});
 const page = await browser.newPage();
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const results=[];
 for(const variant of ['compact','roomy']) for(const theme of ['dark','light']) for(const [width,height] of [[1600,1000],[1280,800],[820,560]]) {
  await page.setViewportSize({width,height});
  await page.goto(`http://127.0.0.1:4324/?variant=${variant}&theme=${theme}`);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(__dirname,`${variant}-${theme}-${width}.png`)});
  results.push({variant,theme,width,height,...await page.evaluate(()=>{
   const panel=document.querySelector('.tools');
   const targets=[document.documentElement,document.body,document.querySelector('.tools-tabs'),panel,document.querySelector('.roster')];
   return {overflow:targets.filter(x=>x.scrollWidth>x.clientWidth+1).map(x=>x.className||x.tagName),panelWidth:panel.getBoundingClientRect().width,font:getComputedStyle(document.querySelector('.agent-title')).fontFamily};
  })});
 }
 await page.setViewportSize({width:1280,height:800});
 await page.goto('http://127.0.0.1:4324/');
 await page.getByRole('button',{name:/Retain agent history/}).click();
 await page.locator('#detail-storage summary').click();
 await page.screenshot({path:path.join(__dirname,'compact-details-dark.png')});
 if(!await page.locator('#detail-storage').isVisible())throw Error('Details did not open');
 await page.keyboard.press('Escape');
 if(await page.locator('#detail-storage').isVisible())throw Error('Escape did not close details');
 await page.getByRole('tab',{name:'Files',exact:true}).click();
 await page.getByRole('button',{name:'Close Tools',exact:true}).click();
 if(await page.locator('.tools').isVisible())throw Error('Tools did not close');
 await page.screenshot({path:path.join(__dirname,'closed-dot-dark.png')});
 await page.getByRole('button',{name:'Tools — agents working',exact:true}).click();
 if(await page.getByRole('tab',{name:'Files',exact:true}).getAttribute('aria-selected')!=='true')throw Error('Selected tab changed');
 await page.getByRole('tab',{name:'Files',exact:true}).press('End');
 if(await page.getByRole('tab',{name:'Agents',exact:true}).getAttribute('aria-selected')!=='true')throw Error('Keyboard tabs failed');
 await page.getByRole('button',{name:'Pin Tools to this thread',exact:true}).click();
 if(await page.locator('#pin').getAttribute('aria-pressed')!=='true')throw Error('Pin failed');
 for(const state of ['finished','disconnected','empty']) {
  await page.locator('#scenario').selectOption(state);
  if(await page.locator('.working-dot').isVisible())throw Error('Dot remains in '+state);
  await page.screenshot({path:path.join(__dirname,`${state}-dark.png`)});
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.locator('#scenario').selectOption('working');
 await page.getByRole('button',{name:/Retain agent history/}).click();
 if(await page.locator('#detail-storage').evaluate(el=>getComputedStyle(el).animationName)!=='none')throw Error('Reduced motion failed');
 await page.setViewportSize({width:820,height:560});
 await page.getByRole('button',{name:'Light theme',exact:true}).click();
 await page.screenshot({path:path.join(__dirname,'details-reduced-light-820.png')});
 const contrast=[];
 for(const theme of ['dark','light']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  contrast.push({theme,...await page.evaluate(()=>{
   const ctx=document.createElement('canvas').getContext('2d');
   function rgba(color){ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]}
   function lum(c){const s=c.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4});return s[0]*.2126+s[1]*.7152+s[2]*.0722}
   return {samples:[...document.querySelectorAll('.agent-title,.agent-model,.agent-status,.agent-time,.details p,.tab,.roster-footer span')].filter(el=>el.getClientRects().length).map(el=>{let parent=el,bg;while(parent){bg=rgba(getComputedStyle(parent).backgroundColor);if(bg[3]===255)break;parent=parent.parentElement}const fg=rgba(getComputedStyle(el).color);const l1=lum(fg),l2=lum(bg);return {text:el.textContent.slice(0,40),ratio:+((Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)).toFixed(2)}})};
  })});
 }
 await fs.writeFile(path.join(__dirname,'verification.json'),JSON.stringify({results,errors,contrast,interactions:'details/history, Escape, close/reopen preserving tab, keyboard tabs, pin, states, reduced motion passed'},null,2));
 console.log(JSON.stringify({results,errors,minimumContrast:Math.min(...contrast.flatMap(x=>x.samples.map(y=>y.ratio))),interactions:'passed'}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
