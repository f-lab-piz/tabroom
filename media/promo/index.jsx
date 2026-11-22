import React from 'react';
import {AbsoluteFill, Composition, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from 'remotion';
import {Video} from '@remotion/media';
import '@fontsource/noto-sans-kr/korean-500.css';
import '@fontsource/noto-sans-kr/korean-700.css';
import '@fontsource/noto-sans-kr/latin-500.css';
import '@fontsource/noto-sans-kr/latin-700.css';
import {fps, scenes} from './story.mjs';

const font = '"Noto Sans KR", "Apple SD Gothic Neo", sans-serif';
const ease = (x) => x * x * (3 - 2 * x);

function Mark() {
  return <span style={{position:'relative',display:'inline-block',width:24,height:24,borderRadius:8,background:'#315fb0',boxShadow:'0 2px 4px #244a9430'}}>
    <span style={{position:'absolute',inset:'6px 5px 6px 5px',border:'1.5px solid white',borderRadius:3}}/>
    <span style={{position:'absolute',left:10,top:7,bottom:7,width:1.5,background:'white'}}/>
  </span>;
}

function Scene({scene, offset}) {
  const frame = useCurrentFrame();
  const length = scene.seconds * fps;
  const now = frame / fps;
  const [fx,fy,strength] = scene.focus;
  const zoom = interpolate(frame,[0,Math.min(42,length*.35),length-Math.min(28,length*.2),length],[1,strength,strength,1],{
    extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:ease,
  });
  const current = scene.captions.findLast(([time])=>now>=time) ?? scene.captions[0];
  const fresh = now-current[0];
  const appear = interpolate(fresh,[0,0.22],[0.35,1],{extrapolateRight:'clamp',easing:ease});
  const last = scene.id==='source';
  const outro = last ? interpolate(now,[5.4,6.35],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:ease}) : 0;

  return <AbsoluteFill style={{fontFamily:font,color:'#16315b',background:'linear-gradient(135deg,#f7faff 0%,#e9f1ff 48%,#f2f7ff 100%)'}}>
    <header style={{position:'absolute',left:177,right:177,top:19,height:29,display:'flex',alignItems:'center',justifyContent:'space-between',fontSize:20,lineHeight:1}}>
      <strong style={{display:'flex',alignItems:'center',gap:11,letterSpacing:-0.5}}><Mark/>탭룸 <span style={{color:'#5173a4',fontSize:17,letterSpacing:0.15}}>Tabroom</span></strong>
      <span style={{color:'#436297',fontSize:21,letterSpacing:-0.4,fontWeight:700}}>{scene.label}</span>
    </header>
    <div style={{position:'absolute',left:174,top:57,width:1572,height:917,border:'1px solid #dbe5f3',borderRadius:21,overflow:'hidden',boxSizing:'border-box',background:'#fff',boxShadow:'0 12px 44px #31558b23'}}>
      <div style={{width:'100%',height:'100%',transform:`scale(${zoom})`,transformOrigin:`${fx*100}% ${fy*100}%`}}>
        <Video src={staticFile(scene.id+'.mp4')} muted style={{width:'100%',height:'100%',display:'block',objectFit:'contain',background:'white'}}/>
      </div>
      {outro>0 && <AbsoluteFill style={{opacity:outro,background:'linear-gradient(145deg,#f1f6ff,#dce9fd)',display:'grid',placeItems:'center'}}>
        <div style={{display:'grid',justifyItems:'center',gap:18,transform:`translateY(${(1-outro)*11}px)`}}>
          <span style={{transform:'scale(2.55)',marginBottom:16}}><Mark/></span>
          <strong style={{fontSize:104,lineHeight:1.2,letterSpacing:-6}}>탭룸</strong>
          <span style={{fontSize:28,color:'#456ba3',letterSpacing:4}}>TABROOM</span>
        </div>
      </AbsoluteFill>}
    </div>
    <div style={{position:'absolute',left:120,right:120,top:990,height:68,display:'grid',placeItems:'center',textAlign:'center'}}>
      <span style={{fontSize:38,fontWeight:700,letterSpacing:-1.5,opacity:appear,transform:`translateY(${(1-appear)*5}px)`}}>{current[1]}</span>
    </div>
    <div style={{position:'absolute',left:0,bottom:0,width:1920*(offset+frame+1)/(60*fps),height:4,background:'#91adde'}}/>
  </AbsoluteFill>;
}

function Promo() {
  let offset = 0;
  return <AbsoluteFill>{scenes.map((scene) => {
    const start = offset;
    const duration = scene.seconds * fps;
    offset += duration;
    return <Sequence key={scene.id} name={scene.label} from={start} durationInFrames={duration} premountFor={10}>
      <Scene scene={scene} offset={start}/>
    </Sequence>;
  })}</AbsoluteFill>;
}

registerRoot(() => <Composition id="TabroomPromo" component={Promo} width={1920} height={1080} fps={fps}
  durationInFrames={scenes.reduce((total,scene)=>total+fps*scene.seconds,0)}/>);
