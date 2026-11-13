/**
 * Layout for /agents/* pages.
 * These pages host the AiAgent component full-screen — no studio chrome needed.
 * 阶段 4.5.3 起：浏览器不再持有供应商凭据，也没有任何密钥 cookie 可供这些页面复用。
 */
export const metadata = {
  title: "Agent Chat — PaintTrack",
};

export default function AgentsLayout({ children }) {
  return (
    <div className="h-screen w-full overflow-hidden bg-black">
      {children}
    </div>
  );
}
