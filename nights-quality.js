/* Shared learning-only GPS filter. Original activity points are never modified. */
function nightsQualitySegments(points, mode='walk') {
  const segments=[], stats={total:(points||[]).length,accepted:0,rejected:0,poorAccuracy:0,jumps:0,gaps:0,stationary:0,badAltitude:0};
  const driving=mode==='drive', accuracyLimit=driving?40:25, maxSpeed=driving?65:3.8, maxGap=driving?60:120;
  let anchor=null;
  const valid=p=>p&&p.lat!=null&&p.lon!=null&&Number.isFinite(+p.lat)&&Number.isFinite(+p.lon)&&Math.abs(+p.lat)<=90&&Math.abs(+p.lon)<=180&&p.t!=null&&Number.isFinite(+p.t)&&+p.t>0;
  for(const original of points||[]) {
    if(!valid(original)){stats.rejected++;anchor=null;continue}
    const p={...original,lat:+original.lat,lon:+original.lon,t:+original.t};
    if(p.accuracy==null||!Number.isFinite(+p.accuracy)||+p.accuracy<=0||+p.accuracy>accuracyLimit){stats.rejected++;stats.poorAccuracy++;anchor=null;continue}
    if(p.segmentBreak){anchor=p;stats.gaps++;continue}
    if(!anchor){anchor=p;continue}
    const seconds=(p.t-anchor.t)/1000, distance=dist(anchor,p),speed=distance/seconds;
    if(seconds<=0||seconds>maxGap){stats.rejected++;stats.gaps++;anchor=p;continue}
    if(!Number.isFinite(distance)||speed>maxSpeed||distance>(driving?1600:240)){stats.rejected++;stats.jumps++;anchor=null;continue}
    const sensorStopped=p.speed!=null&&Number.isFinite(+p.speed)&&+p.speed>=0&&+p.speed<.2;
    if(distance<Math.max(driving?5:4,Math.max(+anchor.accuracy,+p.accuracy)*.2)||speed<(driving?.45:.2)||sensorStopped){stats.stationary++;stats.rejected++;if(sensorStopped)anchor=p;continue}
    let grade=null;
    const goodAltitude=x=>x.altitude!=null&&Number.isFinite(+x.altitude)&&(x.altitudeAccuracy==null||(Number.isFinite(+x.altitudeAccuracy)&&+x.altitudeAccuracy>0&&+x.altitudeAccuracy<=15));
    if(distance>=12&&goodAltitude(anchor)&&goodAltitude(p)){
      const slope=(+p.altitude-+anchor.altitude)/distance*100;
      if(Math.abs(slope)<=35)grade=slope;else stats.badAltitude++;
    }
    segments.push({a:anchor,b:p,distance,seconds,grade});stats.accepted++;anchor=p;
  }
  return {segments,stats};
}
