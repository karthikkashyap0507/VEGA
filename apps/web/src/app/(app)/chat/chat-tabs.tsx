'use client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChatSurface } from './chat-surface';
import { ProgramSandbox } from './program-sandbox';

export function ChatTabs() {
  return (
    <Tabs defaultValue="chat" className="grid gap-4">
      <TabsList>
        <TabsTrigger value="chat">Conversations</TabsTrigger>
        <TabsTrigger value="sandbox">Plan sandbox</TabsTrigger>
      </TabsList>
      <TabsContent value="chat">
        <ChatSurface />
      </TabsContent>
      <TabsContent value="sandbox">
        <ProgramSandbox />
      </TabsContent>
    </Tabs>
  );
}
