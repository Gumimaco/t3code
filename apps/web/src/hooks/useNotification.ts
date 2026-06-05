import { useCallback, useEffect, useState } from "react";
import {
  getNotificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
} from "../lib/nativeNotifications";

export function useNotification() {
  const [permission, setPermission] = useState<NotificationPermissionState>(
    getNotificationPermission(),
  );

  const refresh = useCallback(() => {
    setPermission(getNotificationPermission());
  }, []);

  const requestPermission = useCallback(async () => {
    const nextPermission = await requestNotificationPermission();
    setPermission(nextPermission);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return { permission, requestPermission, refresh };
}
