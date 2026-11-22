import {element} from './markdown.js';

const colors = ['#206857','#3b68a5','#a35324','#775395','#6f761d'];
const number = new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2});

export function renderChart(node) {
  const panel = element('section',undefined,'widget-chart');
  const canvas = element('canvas');
  canvas.width = 640;
  canvas.height = 240;
  canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label',node.label);
  const legend = element('div',undefined,'widget-legend');
  const values = element('details');
  values.append(element('summary','차트 데이터 보기'));
  const tableWrap = element('div',undefined,'response-table-wrap');
  const table = element('table');
  table.createCaption().textContent = node.label;
  const head = table.createTHead().insertRow();
  for (const label of ['항목',...node.series.map(series=>series.label)]) {
    const th = element('th',label);
    th.scope = 'col';
    head.append(th);
  }
  const body = table.createTBody();
  node.labels.forEach((label,index)=>{
    const row = body.insertRow();
    row.insertCell().textContent = label;
    node.series.forEach(series=>{ row.insertCell().textContent = number.format(series.values[index]); });
  });
  tableWrap.append(table);
  values.append(tableWrap);
  panel.append(element('h4',node.label),legend,canvas,values);
  const hidden = new Set();

  function draw() {
    const context = canvas.getContext('2d');
    if (!context) return;
    const series = node.series.map((item,index)=>({...item,index})).filter(item=>!hidden.has(item.index));
    const all = series.flatMap(item=>item.values);
    const min = Math.min(0,...all);
    const max = Math.max(0,...all);
    const left = 62, right = 620, top = 17, bottom = 204;
    const y = value => bottom-(value-min)/(max-min || 1)*(bottom-top);
    const slot = (right-left)/node.labels.length;
    const x = index => left + (index+.5)*slot;
    context.clearRect(0,0,canvas.width,canvas.height);
    context.font = '12px system-ui, sans-serif';
    context.fillStyle = '#405763';
    context.strokeStyle = '#dce6e8';
    context.textAlign = 'right';
    for (let i=0;i<=4;i++) {
      const n = min+(max-min || 1)*i/4;
      context.beginPath();
      context.moveTo(left,y(n));
      context.lineTo(right,y(n));
      context.stroke();
      context.fillText(number.format(n),left-6,y(n)+4,54);
    }
    if (!series.length) {
      context.textAlign = 'center';
      context.fillText('표시할 계열을 선택하세요',320,110);
      return;
    }
    context.textAlign = 'center';
    const labelStep = Math.max(1,Math.ceil(node.labels.length/7));
    node.labels.forEach((label,i)=>{
      if (i%labelStep===0) context.fillText(label.length>15 ? label.slice(0,14)+'…' : label,x(i),226,76);
    });
    series.forEach((item,s)=>{
      context.strokeStyle = context.fillStyle = colors[item.index];
      const barWidth = Math.max(1,slot*.7/series.length);
      if (node.kind==='bar') {
        item.values.forEach((value,i)=>{
          context.fillRect(x(i)-barWidth*series.length/2+barWidth*s,Math.min(y(0),y(value)),
            Math.max(1,barWidth-1),Math.max(1,Math.abs(y(value)-y(0))));
        });
        return;
      }
      context.lineWidth = 2;
      context.beginPath();
      item.values.forEach((value,i)=>{ if (i===0) context.moveTo(x(i),y(value)); else context.lineTo(x(i),y(value)); });
      context.stroke();
      item.values.forEach((value,i)=>{
        context.beginPath();
        context.arc(x(i),y(value),3,0,Math.PI*2);
        context.fill();
      });
    });
  }

  node.series.forEach((series,i)=>{
    const button = element('button',series.label,'response-button');
    button.type = 'button';
    button.style.setProperty('--series-color',colors[i]);
    button.setAttribute('aria-pressed','true');
    button.addEventListener('click',()=>{
      if (hidden.has(i)) hidden.delete(i);
      else hidden.add(i);
      button.setAttribute('aria-pressed',String(!hidden.has(i)));
      draw();
    });
    legend.append(button);
  });
  draw();
  return panel;
}
