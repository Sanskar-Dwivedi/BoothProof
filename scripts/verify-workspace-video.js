async page => {
  await page.goto('http://127.0.0.1:4176/workspace-video-preview.html');
  await page.waitForFunction(()=>{const v=document.querySelector('video');return v.readyState>=2&&v.duration>0;});
  const video=page.locator('video');
  const metadata=await video.evaluate(v=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight,error:v.error?.message??null}));
  await video.evaluate(v=>v.play());await page.waitForTimeout(300);await video.evaluate(v=>v.pause());
  for(const [second,name] of [[5,'start'],[21,'assignment'],[61,'ending']]) {
    await video.evaluate((v,t)=>new Promise(resolve=>{v.addEventListener('seeked',resolve,{once:true});v.currentTime=t;}),second);
    await page.screenshot({path:'output/playwright/workspace-simulated-video-'+name+'.png'});
  }
  if(metadata.error||metadata.duration>120||metadata.width!==1366||metadata.height!==900)throw new Error('Invalid demonstration video.');
  return {...metadata,playbackAndSeeking:true,kind:'offline_demo'};
}
