import { AskChatPage } from "@/components/ask/ask-pages";

/** Ask › a chat (`src/components/ask`); full screen on a phone, without the tab bar. */
export default async function AskChatRoute({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <AskChatPage chatId={chatId} />;
}
