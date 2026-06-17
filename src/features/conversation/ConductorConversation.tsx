import { ConductorComposer } from "./ConductorComposer";
import { ConductorSidebar } from "./ConductorSidebar";
import { ConductorThread } from "./ConductorThread";

export function ConductorConversation({ session }: { session: string }) {
  return (
    <>
      <ConductorSidebar />
      <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
        <ConductorThread session={session} />
        <ConductorComposer session={session} />
      </div>
    </>
  );
}
