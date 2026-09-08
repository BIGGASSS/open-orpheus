import { installRequestCachePersistence } from "./requestCacheRuntime";

const MARKER = 'const v="api.dbcache",h=async e=>{';
const PATCHED = "/* open-orpheus:durable-request-cache-v4 */";

/**
 * Compatibility shim for the upstream api.dbcache module. The signed archive
 * remains untouched; only the JS served by the orpheus protocol is transformed.
 * Match all known anchors before editing, so a package update cannot receive a
 * partial patch. Refuse an incompatible cache module instead of silently serving
 * the known lossy implementation. Unrelated scripts are returned unchanged.
 */
export function patchRequestCache(source: string): string {
  if (source.includes(PATCHED) || !source.includes("api.dbcache"))
    return source;
  const start = source.indexOf(MARKER);
  const end = source.indexOf("}},function(", start);
  if (
    start < 0 ||
    end < 0 ||
    source.indexOf(MARKER, start + MARKER.length) !== -1
  ) {
    throw new Error(
      "Unsupported frontend request cache module; update the compatibility patch"
    );
  }
  let module = source.slice(start, end);
  const replacements = [
    [
      "this.initPromise=this.init()}async init()",
      `this.initPromise=this.init(),${PATCHED}(${installRequestCachePersistence.toString()})(this,i.Database,{limits:()=>{const config=l.a.getStore().configCenter?.["preload#requestFallback"],defaults=d.a["preload#requestFallback"];return{maxCacheCountInLocal:config?.maxCacheCountInLocal||defaults.maxCacheCountInLocal,overCleanPercentInLocal:config?.overCleanPercentInLocal||defaults.overCleanPercentInLocal}},uid:()=>l.a.getStore().host.uid,clone:value=>Object(r.a)(value),report:error=>a.b.error(v,"durable cache flush failed",error)})}async init()`,
    ],
    [
      "r=i.slice(0,e);n.set(r,t)",
      "r=i.slice(0,e);Number.isFinite(t)&&t>(n.get(r)??-Infinity)&&n.set(r,t)",
    ],
    [
      'else if(this.cachedKeys.has(c)){let e=await this.getCacheResultByKey(c,"request error")',
      'else{let e=await this.getCacheResultByKey(c,"request error")',
    ],
    [
      "this.cachedKeys.set(c,Date.now())",
      "this.cachedKeys.set(c,Math.max(Date.now(),(this.cachedKeys.get(c)||0)+1))",
    ],
  ];
  for (const [before] of replacements) {
    if (module.split(before).length !== 2) {
      throw new Error(
        "Unsupported frontend request cache implementation; update the compatibility patch"
      );
    }
  }
  for (const [before, after] of replacements)
    module = module.replace(before, () => after);
  // Scope ordering arguments to postResponse, including its batch-read await.
  const responseStart = module.indexOf("postResponse(e)");
  const responseEnd = module.indexOf("computeRequestKey(e){", responseStart);
  const stop = responseEnd < 0 ? module.length : responseEnd;
  const responseSource = module.slice(responseStart, stop);
  for (const anchor of [
    "this.updateToBeCleanCacheMap(c)",
    "this.runtimeCacheMap.set(c,",
  ]) {
    if (responseSource.split(anchor).length !== 2)
      throw new Error(
        "Unsupported frontend request cache response; update the compatibility patch"
      );
  }
  const success = "if(200===(null===(o=t.body)||void 0===o?void 0:o.code)){";
  const finish = "this.tryToFlushCacheToStore()}}else";
  if (
    responseSource.split(success).length !== 2 ||
    responseSource.split(finish).length !== 2
  )
    throw new Error(
      "Unsupported frontend request cache success branch; update the compatibility patch"
    );
  const response = responseSource
    .replace(
      success,
      success +
        "await this.runCacheResponse(c,t.body,async(orpheusTicket,orpheusSnapshot)=>{await this.initPromise;await this.refreshCacheKeys();t.body=orpheusSnapshot;"
    )
    .replace(finish, "this.tryToFlushCacheToStore()}).catch(()=>{});}}else")
    .replaceAll(
      "this.updateToBeCleanCacheMap(c)",
      "this.updateToBeCleanCacheMap(c,orpheusTicket)"
    )
    .replaceAll(
      "this.updateToBeCleanCacheMap(e)",
      "this.updateToBeCleanCacheMap(e,orpheusTicket)"
    )
    .replace(
      "this.runtimeCacheMap.set(c,",
      "this.stageCacheValue(c,orpheusTicket,"
    );
  module = module.slice(0, responseStart) + response + module.slice(stop);
  return source.slice(0, start) + module + source.slice(end);
}
