import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Camera, CameraResultType, CameraSource, CameraDirection } from '@capacitor/camera';
import { PushNotifications } from '@capacitor/push-notifications';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

window.WalkMemoryNative = {
  isAvailable() { return Capacitor.isNativePlatform(); },
  cameraAvailable() { return Capacitor.isNativePlatform(); },
  async registerPush(onToken,onNotification) {
    if (!Capacitor.isNativePlatform()) return false;
    await PushNotifications.createChannel({id:'nights_partner',name:'Partner activity updates',description:'Live shared activity and partner photo updates',importance:4,visibility:1});
    await PushNotifications.addListener('registration',x=>onToken?.(x.value));
    await PushNotifications.addListener('pushNotificationReceived',x=>onNotification?.(x));
    await PushNotifications.addListener('pushNotificationActionPerformed',x=>onNotification?.(x.notification));
    const permission=await PushNotifications.requestPermissions();
    if(permission.receive!=='granted')return false;
    await PushNotifications.register();
    return true;
  },
  async takePhoto() {
    const p = await Camera.getPhoto({quality:88,width:1600,height:1600,allowEditing:false,correctOrientation:true,resultType:CameraResultType.DataUrl,source:CameraSource.Camera,direction:CameraDirection.Rear,promptLabelHeader:'Nights Camera'});
    return {dataUrl:p.dataUrl,format:p.format};
  },
  async choosePhoto() {
    const p = await Camera.getPhoto({quality:88,width:1600,height:1600,allowEditing:false,correctOrientation:true,resultType:CameraResultType.DataUrl,source:CameraSource.Photos,promptLabelHeader:'Choose Photo'});
    return {dataUrl:p.dataUrl,format:p.format};
  },
  async start(onLocation, onError) {
    try { await LocalNotifications.requestPermissions(); } catch {}
    return BackgroundGeolocation.addWatcher({
      backgroundMessage: 'Nights is recording your activity. Tap to return.',
      backgroundTitle: 'Nights tracking',
      requestPermissions: true,
      stale: false,
      distanceFilter: 2
    }, (location, error) => {
      if (error) return onError?.(error);
      if (location) onLocation?.(location);
    });
  },
  async stop(id) { if (id != null) await BackgroundGeolocation.removeWatcher({id}); },
  async openSettings() { await BackgroundGeolocation.openSettings(); }
};
