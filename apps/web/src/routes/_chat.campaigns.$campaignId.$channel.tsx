import { createFileRoute } from "@tanstack/react-router";

import { CampaignDraftEditor } from "../components/CampaignDraftEditor";
import { SidebarInset } from "../components/ui/sidebar";

function DraftChannelRouteView() {
  const { campaignId, channel } = Route.useParams();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <CampaignDraftEditor campaignId={campaignId} channel={channel} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/campaigns/$campaignId/$channel")({
  component: DraftChannelRouteView,
});
