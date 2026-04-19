/**
 * CampaignSidebar — primary navigation surface in Content Studio.
 *
 * Lists campaigns grouped by status. Each campaign row can expand to reveal
 * per-channel drafts, letting the user jump directly to a specific draft
 * editor. This is the only sidebar Content Studio exposes — there is no
 * generic thread list.
 */

import {
  CheckCircle2Icon,
  ChevronRightIcon,
  Loader2Icon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import {
  type Campaign,
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_ORDER,
  deriveDraftStatus,
  DRAFT_STATUS_LABEL,
  type DraftOutput,
  type DraftOutputStatus,
  useCampaignStore,
} from "../campaignStore";
import { getChannelLabel } from "../campaignChannels";
import { formatRelativeTimeLabel } from "../timestampFormat";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function StatusDot({ status }: { status: Campaign["status"] }) {
  const color =
    status === "in_progress"
      ? "bg-sky-500"
      : status === "ready"
        ? "bg-emerald-500"
        : status === "archived"
          ? "bg-muted-foreground/60"
          : "bg-amber-500";
  return <span className={`inline-block size-1.5 rounded-full ${color}`} />;
}

function DraftStatusChip({ status }: { status: DraftOutputStatus }) {
  const style =
    status === "approved"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "review"
        ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
        : status === "generating"
          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
          : status === "empty"
            ? "bg-muted text-muted-foreground"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return (
    <span className={`rounded px-1 py-px text-[9px] font-medium leading-tight ${style}`}>
      {DRAFT_STATUS_LABEL[status]}
    </span>
  );
}

function DraftChildRow({
  campaignId,
  draft,
  isActive,
  onClick,
}: {
  campaignId: string;
  draft: DraftOutput;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={onClick}
        size="sm"
        className="pl-7"
        data-campaign-id={campaignId}
      >
        <span className="min-w-0 flex-1 truncate text-[12px]">
          {getChannelLabel(draft.channel)}
        </span>
        <DraftStatusChip status={deriveDraftStatus(draft)} />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function CampaignRow({
  campaign,
  isActive,
  expanded,
  activeChannel,
  onToggle,
  onNavigate,
  onNavigateDraft,
}: {
  campaign: Campaign;
  isActive: boolean;
  expanded: boolean;
  activeChannel: string | null;
  onToggle: () => void;
  onNavigate: () => void;
  onNavigateDraft: (draft: DraftOutput) => void;
}) {
  const approvedCount = campaign.drafts.filter((draft) => draft.review === "approved").length;
  const generatingCount = campaign.drafts.filter((draft) => draft.progress === "generating").length;
  const totalDrafts = campaign.drafts.length;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={isActive}
          className="h-auto min-h-9 flex-col items-start gap-1 px-2 py-1.5"
          onClick={onNavigate}
        >
          <div className="flex w-full items-center gap-1.5">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
              className="flex size-4 items-center justify-center rounded hover:bg-accent/60"
              aria-label={expanded ? "Sbalit kampaň" : "Rozbalit kampaň"}
            >
              <ChevronRightIcon
                className={`size-3 text-muted-foreground transition-transform ${
                  expanded ? "rotate-90" : ""
                }`}
              />
            </button>
            <StatusDot status={campaign.status} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {campaign.name || "Kampaň bez názvu"}
            </span>
            {generatingCount > 0 ? (
              <Loader2Icon className="size-3 animate-spin text-sky-500" />
            ) : approvedCount === totalDrafts && totalDrafts > 0 ? (
              <CheckCircle2Icon className="size-3 text-emerald-500" />
            ) : null}
          </div>
          <div className="flex w-full items-center justify-between pl-[22px] text-[10px] text-muted-foreground">
            <span className="truncate">
              {totalDrafts === 0
                ? "Zatím žádné drafty"
                : `${approvedCount}/${totalDrafts} schváleno`}
            </span>
            <span className="shrink-0">{formatRelativeTimeLabel(campaign.updatedAt)}</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>

      {expanded &&
        campaign.drafts.map((draft) => (
          <DraftChildRow
            key={draft.id}
            campaignId={campaign.id}
            draft={draft}
            isActive={isActive && activeChannel === draft.channel}
            onClick={() => onNavigateDraft(draft)}
          />
        ))}
    </>
  );
}

export function CampaignSidebar() {
  const navigate = useNavigate();
  const routeCampaignId = useParams({
    strict: false,
    select: (params: { campaignId?: string }) => params.campaignId ?? null,
  });
  const routeChannel = useParams({
    strict: false,
    select: (params: { channel?: string }) => params.channel ?? null,
  });
  const campaigns = useCampaignStore((store) => store.campaigns);
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(() => {
    return routeCampaignId ? new Set([routeCampaignId]) : new Set();
  });

  const grouped = useMemo(() => {
    const groups = new Map<Campaign["status"], Campaign[]>();
    for (const status of CAMPAIGN_STATUS_ORDER) {
      groups.set(status, []);
    }
    for (const campaign of campaigns) {
      const bucket = groups.get(campaign.status) ?? [];
      bucket.push(campaign);
      groups.set(campaign.status, bucket);
    }
    for (const [, bucket] of groups) {
      bucket.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return groups;
  }, [campaigns]);

  const toggleCampaign = useCallback((campaignId: string) => {
    setExpandedCampaigns((prev) => {
      const next = new Set(prev);
      if (next.has(campaignId)) {
        next.delete(campaignId);
      } else {
        next.add(campaignId);
      }
      return next;
    });
  }, []);

  const openNew = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);

  const goToCampaign = useCallback(
    (campaign: Campaign) => {
      setExpandedCampaigns((prev) => {
        if (prev.has(campaign.id)) return prev;
        const next = new Set(prev);
        next.add(campaign.id);
        return next;
      });
      void navigate({
        to: "/campaigns/$campaignId",
        params: { campaignId: campaign.id },
      });
    },
    [navigate],
  );

  const goToDraft = useCallback(
    (campaign: Campaign, draft: DraftOutput) => {
      void navigate({
        to: "/campaigns/$campaignId/$channel",
        params: { campaignId: campaign.id, channel: draft.channel },
      });
    },
    [navigate],
  );

  return (
    <>
      <SidebarHeader className="flex flex-row items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <SparklesIcon className="size-4 text-sky-500" />
          Content Studio
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon" className="size-6" onClick={openNew}>
                <PlusIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup side="right">Nová kampaň</TooltipPopup>
        </Tooltip>
      </SidebarHeader>

      <SidebarContent className="overflow-y-auto">
        {campaigns.length === 0 ? (
          <div className="px-3 pt-2 text-[11px] leading-5 text-muted-foreground">
            Zatím žádné kampaně. Použijte tlačítko{" "}
            <span className="font-medium text-foreground">Nová kampaň</span> a založte svou první.
          </div>
        ) : null}

        {CAMPAIGN_STATUS_ORDER.map((status) => {
          const bucket = grouped.get(status) ?? [];
          if (bucket.length === 0) return null;

          return (
            <SidebarGroup key={status}>
              <SidebarGroupLabel className="flex items-center gap-1.5">
                <StatusDot status={status} />
                <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wider">
                  {CAMPAIGN_STATUS_LABEL[status]}
                </span>
                <span className="text-[10px] text-muted-foreground">{bucket.length}</span>
              </SidebarGroupLabel>
              <SidebarMenu>
                {bucket.map((campaign) => (
                  <CampaignRow
                    key={campaign.id}
                    campaign={campaign}
                    isActive={routeCampaignId === campaign.id}
                    expanded={expandedCampaigns.has(campaign.id)}
                    activeChannel={routeCampaignId === campaign.id ? routeChannel : null}
                    onToggle={() => toggleCampaign(campaign.id)}
                    onNavigate={() => goToCampaign(campaign)}
                    onNavigateDraft={(draft) => goToDraft(campaign, draft)}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="px-3 py-2">
        <div className="flex items-center justify-between">
          <Link
            to="/settings"
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <SettingsIcon className="size-3" />
            Nastavení
          </Link>
          <span className="text-[10px] text-muted-foreground">
            {APP_STAGE_LABEL} {APP_VERSION}
          </span>
        </div>
      </SidebarFooter>
    </>
  );
}
