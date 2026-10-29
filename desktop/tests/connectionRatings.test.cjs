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

test('layovers use fixed bands in both directions regardless of other connections',()=>{
 const rows=[{outbound:leg(120),inbound:leg(300)},{outbound:leg(300),inbound:leg(600)}];
 const ratings=connectionRatings(rows,flightTimelines(rows));
 assert.equal(ratings.outbound.get(300).level,3);
 assert.equal(ratings.inbound.get(300).level,3);
 assert.equal(ratings.outbound.get(120).level,1);
 assert.equal(ratings.inbound.get(600).level,4);
 assert.equal(ratings.outbound.has(600),false);
 const changed=[{outbound:leg(120),inbound:leg(60)},{outbound:leg(300),inbound:leg(600)}];
 assert.deepEqual(connectionRatings(changed,flightTimelines(changed)).outbound.get(300),ratings.outbound.get(300));
});
test('tight connections remain tight and empty directions have no ratings',()=>{
 const rows=[{outbound:leg(0)},{outbound:leg(30)},{outbound:leg(120)}];
 const ratings=connectionRatings(rows,flightTimelines(rows));
 assert.equal(ratings.outbound.get(0).level,3);
 assert.match(ratings.outbound.get(30).description,/^Tight/);
 assert.equal(ratings.outbound.get(120).level,1);
 assert.equal(ratings.inbound.size,0);
 assert.equal(connectionRatings([],flightTimelines([])).outbound.size,0);
});
