/* LUXE Android native folder bridge. Load before app.js. */
(function(){"use strict";
const nativeAvailable=typeof window.LuxeAndroid!=="undefined"&&typeof window.LuxeAndroid.pickMusicFolder==="function";
window.LUXEAndroid=window.LUXEAndroid||{};
window.LUXEAndroid.isNative=nativeAvailable;
window.LUXEAndroid.pickFolder=function(){if(!nativeAvailable)return false;window.LuxeAndroid.pickMusicFolder();return true};
window.LUXEAndroid.rescan=function(){if(!nativeAvailable||!window.LuxeAndroid.rescanMusicFolder)return false;window.LuxeAndroid.rescanMusicFolder();return true};
window.LUXEAndroid.forgetFolder=function(){if(!nativeAvailable||!window.LuxeAndroid.forgetMusicFolder)return false;window.LuxeAndroid.forgetMusicFolder();return true};
window.LUXEAndroid.onFolderSelected=function(json){let payload;try{payload=typeof json==="string"?JSON.parse(json):json}catch(e){console.error(e);return}window.dispatchEvent(new CustomEvent("luxe:native-library",{detail:payload}))};
window.LUXEAndroid.onError=function(message){window.dispatchEvent(new CustomEvent("luxe:native-error",{detail:{message:String(message||"Native folder error")}}))};
window.LUXEAndroid.onFolderCleared=function(){window.dispatchEvent(new CustomEvent("luxe:native-folder-cleared"))};
window.LUXEAndroid.onNativeArtworkUpdated=function(id,artwork){if(typeof window.LUXEAndroid._nativeArtworkHandler==="function")window.LUXEAndroid._nativeArtworkHandler(id,artwork)};
window.LUXEAndroid.onNativeSongMetadataUpdated=function(song){if(typeof window.LUXEAndroid._nativeMetadataHandler==="function")window.LUXEAndroid._nativeMetadataHandler(song)};
window.LUXEAndroid.onNativeStatus=function(message){if(typeof window.LUXEAndroid._nativeStatusHandler==="function")window.LUXEAndroid._nativeStatusHandler(message)};
document.addEventListener("DOMContentLoaded",function(){const button=document.querySelector("#chooseFolderBtn");if(!button||!nativeAvailable)return;button.addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();window.LuxeAndroid.pickMusicFolder()},true)});
})();
