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
test('connection colors include both directions and follow filtered extrema',()=>{
 const rows=[{outbound:leg(60)},{outbound:leg(120),inbound:leg(360)}];
 const all=connectionRatings(flightTimelines(rows));
 assert.equal(all.get(60).level,1);
 assert.equal(all.get(360).level,5);
 assert.match(all.get(360).description,/Longest connections/);
 const filtered=connectionRatings(flightTimelines([{outbound:rows[0].outbound},{outbound:rows[1].outbound}]));
 assert.equal(filtered.get(120).level,5);
 assert.equal(filtered.has(360),false);
});
test('zero-minute known connections are rated while missing connections are not invented',()=>{
 const ratings=connectionRatings(flightTimelines([{outbound:leg(0)},{outbound:leg(60)}]));
 assert.equal(ratings.get(0).level,1);
 assert.equal(ratings.get(60).level,5);
 assert.equal(connectionRatings(flightTimelines([])).size,0);
});
