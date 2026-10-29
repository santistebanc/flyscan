const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ stdin:{contents:`export { connectionRatings } from './src/connectionRatings'; export { flightTimelines } from './src/flightTimeline';`,resolveDir:path.join(__dirname,'..')},
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { connectionRatings, flightTimelines } = mod.exports;
const stamp=(minutes)=>new Date(Date.UTC(2026,10,13,8,minutes)).toISOString().slice(0,16);
const leg=(gap)=>({ departure:stamp(0),arrival:stamp(120+gap),duration:`${Math.floor((120+gap)/60)}h ${gap%60}m`,
  segments:[{origin:'BER',destination:'MAD',departure:stamp(0),arrival:stamp(60),duration:'1h'},
    {origin:'MAD',destination:'SLP',departure:stamp(60+gap),arrival:stamp(120+gap),duration:'1h'}] });
test('connections are rated on fixed thresholds, in both directions',()=>{
 const rows=[{outbound:leg(30)},{outbound:leg(120),inbound:leg(300)},{outbound:leg(600),inbound:leg(900)}];
 const ratings=connectionRatings(flightTimelines(rows));
 assert.deepEqual([30,120,300,600,900].map((m)=>ratings.get(m).level),[3,1,3,4,5]);
 assert.match(ratings.get(30).description,/^Tight/);
 assert.match(ratings.get(900).description,/Over 12h/);
});
test('a connection keeps its rating whatever else is in the list',()=>{
 const alone=connectionRatings(flightTimelines([{outbound:leg(120)}]));
 const mixed=connectionRatings(flightTimelines([{outbound:leg(120)},{outbound:leg(60)},{outbound:leg(900)}]));
 assert.deepEqual(alone.get(120),mixed.get(120));
 assert.equal(alone.has(900),false);
});
test('zero-minute known connections are rated while missing connections are not invented',()=>{
 const ratings=connectionRatings(flightTimelines([{outbound:leg(0)},{outbound:leg(60)}]));
 assert.equal(ratings.get(0).level,3);
 assert.equal(ratings.get(60).level,1);
 assert.equal(connectionRatings(flightTimelines([])).size,0);
});
