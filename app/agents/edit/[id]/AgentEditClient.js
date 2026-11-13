"use client";

import { EditAgentPage } from "ai-agent";
import "ai-agent/dist/tailwind.css";
import { useCallback } from "react";

// 阶段 4.5.3：不再从 localStorage / cookie 读取供应商密钥，也不再向内部代理
// 注入供应商密钥请求头。供应商凭据只存在于服务端（lib/server/providers/providerConfig.js），
// 浏览器侧没有任何凭据来源。
export default function AgentEditClient({ userData }) {
  const useUser = useCallback(
    () => ({
      user: {
        username: userData?.email?.split("@")[0] || "Studio User",
        name: userData?.email?.split("@")[0] || "Studio User",
        email: userData?.email || null,
        profile_photo: null,
        balance: userData?.balance || 0,
      },
      isAuthorized: !!userData,
    }),
    [userData]
  );

  return (
    <EditAgentPage
      useUser={useUser}
      usedIn="studio"
    />
  );
}
