import { installPlaylistCachePersistence } from "./playlistCacheRuntime";

const PATCHED = "/* open-orpheus:durable-playlist-cache-v1 */";
const HELPER =
  'const o="playlistTrackIds",a=async e=>{try{const{id:t,trackIds:n,updateTime:r}=e,a=await i.Database.transaction([o]);await a(async e=>{await i.Database.put({tableName:o,rows:[{id:t,trackIds:n,updateTime:r}],retTrans:e})})}catch(t){r.b.warn("upsertTrackIdsToDb error",t)}},l=async e=>{const t=await i.Database.get({tableName:o,compare:{compareColName:"id",compareVal:e.id}});return null!==t&&void 0!==t?t:{}},c=async e=>{try{const{tracks:t}=e,n=await i.Database.transaction(["dbTrack"]);await n(async e=>{await i.Database.put({tableName:"dbTrack",rows:t,retTrans:e})})}catch(t){r.b.warn("upsertTracksToDb error",t)}},s=async e=>{const{ids:t}=e,n=i.Database.sqlQuery().from("dbTrack").whereIn("id",t);return i.Database.execlSqlQuery(n)}';
const EXPORTS =
  'n.d(t,"a",(function(){return o})),n.d(t,"d",(function(){return a})),n.d(t,"b",(function(){return l})),n.d(t,"e",(function(){return c})),n.d(t,"c",(function(){return s}));var i=n(4),r=n(2);';
function refuse(): never {
  throw new Error(
    "Unsupported frontend playlist cache implementation; update the compatibility patch"
  );
}
function replaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) refuse();
  return source.replace(before, () => after);
}

/** All source-specific anchors must match before a transformed script is served. */
export function patchPlaylistCache(source: string): string {
  if (source.includes(PATCHED)) return source;
  let result = source;
  if (
    source.includes(EXPORTS) ||
    source.includes("upsertTrackIdsToDb") ||
    source.includes('const o="playlistTrackIds"')
  ) {
    const replacement =
      'const o="playlistTrackIds",orpheusPlaylistCache=(' +
      installPlaylistCachePersistence.toString() +
      ')(i.Database,error=>r.b.warn("durable playlist cache",error)),a=e=>orpheusPlaylistCache.upsertTrackIds(e),l=async e=>{const t=await i.Database.get({tableName:o,compare:{compareColName:"id",compareVal:e.id}});return null!==t&&void 0!==t?t:{}},c=e=>orpheusPlaylistCache.upsertTracks(e),s=async e=>{const{ids:t}=e,n=i.Database.sqlQuery().from("dbTrack").whereIn("id",t);return i.Database.execlSqlQuery(n)}';
    result = replaceOnce(
      result,
      EXPORTS + HELPER,
      EXPORTS + PATCHED + replacement
    );
  }
  const is137 = source.includes(".push([[137],");
  const is142 = source.includes(".push([[142],");
  if (is137 || is142) {
    const start = result.indexOf("requestPlaylistDetail(");
    const end = result.indexOf(
      is137 ? ",requestPlaylistTracksDetail(" : ",requestYearlyRankData(",
      start
    );
    if (start < 0 || end < 0) refuse();
    let method = result.slice(start, end);
    const replacements = is137
      ? [
          [
            "}),T=!0;if(e){const{trackIds:e,updateTime:r=0}=yield n(c.b,{id:t});if(T=r<g.updateTime,e){",
            "});if(e){const{trackIds:e}=yield n(c.b,{id:t});if(e){",
          ],
          [
            'g.trackCount=i.length,g.trackIds=i}}yield l({type:"setTracks"',
            'g.trackCount=i.length,g.trackIds=i}}try{yield n(c.d,{id:g.id,updateTime:g.updateTime,trackIds:g.trackIds,tracks:k})}catch(orpheusCacheError){/* runtime reports and retains failed persistence; do not enter network fallback */}yield l({type:"setTracks"',
          ],
          [
            String.raw`,e&&(yield n(c.e,{tracks:k}),T&&(b.b.info("playlist","\u7528\u6237\u81ea\u5efa\u6b4c\u5355\u66f4\u65b0\u5230\u672c\u5730\u6570\u636e\u5e93"),yield n(c.d,{id:g.id,updateTime:g.updateTime,trackIds:g.trackIds})))`,
            "",
          ],
        ]
      : [
          [
            "}),u=!0;if(t){const{trackIds:t,updateTime:n=0}=yield i(y.b,{id:e});if(u=n<a.updateTime,t){",
            "});if(t){const{trackIds:t}=yield i(y.b,{id:e});if(t){",
          ],
          [
            'a.trackCount=c.length,a.trackIds=c}}yield c({type:"setTracks"',
            'a.trackCount=c.length,a.trackIds=c}}try{yield i(y.d,{id:a.id,updateTime:a.updateTime,trackIds:a.trackIds,tracks:r})}catch(orpheusCacheError){/* runtime reports and retains failed persistence; do not enter network fallback */}yield c({type:"setTracks"',
          ],
          [
            String.raw`t&&(yield i(y.e,{tracks:r}),u&&(l.b.info("playlist","\u7528\u6237\u81ea\u5efa\u6b4c\u5355\u66f4\u65b0\u5230\u672c\u5730\u6570\u636e\u5e93"),yield i(y.d,{id:a.id,updateTime:a.updateTime,trackIds:a.trackIds})));`,
            "",
          ],
        ];
    for (const [before, after] of replacements)
      method = replaceOnce(method, before, after);
    result = result.slice(0, start) + PATCHED + method + result.slice(end);
  }
  return result;
}
