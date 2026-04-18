import { createFileRoute } from "@tanstack/react-router";

import { IS_CONTENT_STUDIO } from "../branding";
import { CampaignCreateForm } from "../components/CampaignCreateForm";
import { NoActiveThreadState } from "../components/NoActiveThreadState";

function ContentStudioHomeView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        <CampaignCreateForm variant="hero" />
      </div>
    </div>
  );
}

function ChatIndexRouteView() {
  if (IS_CONTENT_STUDIO) {
    return <ContentStudioHomeView />;
  }
  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
