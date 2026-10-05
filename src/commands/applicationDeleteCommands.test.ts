import { ChannelType } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { handleApplicationCommand } from "./application.js";

test("application delete command enforces reviewer-and-closed gates and deletes immediately", async () => {
  const h = fixture(); await handleApplicationCommand(h.command as never, h.repository as never, {} as never, {} as never);
  assert.deepEqual(h.events, ["delete", "mark", "reload"]); assert.equal(title(h.replies.at(-1)), "application was deleted. The retained application record and decision were not deleted.");
  const denied = fixture({ roles: [] }); await handleApplicationCommand(denied.command as never, denied.repository as never, {} as never, {} as never); assert.equal(title(denied.replies.at(-1)), "Only members with <@&reviewer> can perform this action.");
  const open = fixture({ status: "open" }); await handleApplicationCommand(open.command as never, open.repository as never, {} as never, {} as never); assert.equal(title(open.replies.at(-1)), "This application channel must be closed before it can be deleted.");
});

test("application delete leaves state unmarked on Discord failure and marks only after successful deletion", async () => {
  const failed = fixture({ deleteError: new Error("no") }); await assert.rejects(() => handleApplicationCommand(failed.command as never, failed.repository as never, {} as never, {} as never), /no/); assert.deepEqual(failed.events, ["delete"]);
  const success = fixture(); await handleApplicationCommand(success.command as never, success.repository as never, {} as never, {} as never); assert.deepEqual(success.events, ["delete", "mark", "reload"]);
});
function fixture(input: any = {}) { const events: string[]=[]; const open: any={ applicationId:"application", applicationClassId:"class", applicantDiscordUserId:"applicant", ticketChannelId:"channel", channelStatus:input.status??"closed", status:"accepted" }; const cls:any={reviewerRoleId:"reviewer"}; const channel:any={id:"channel",name:"application",type:ChannelType.GuildText,client:{user:{id:"bot"}},delete:async()=>{events.push("delete");if(input.deleteError)throw input.deleteError;}}; const guild:any={id:"guild",channels:{cache:new Map([["channel",channel]]),fetch:async()=>channel}}; const repository:any={listOperationalApplicationTargets:async()=>[{applicationId:"application",applicationName:"Raiders",applicantDiscordUserId:"applicant",ticketChannelId:"channel",status:"accepted",channelStatus:open.channelStatus,reviewerRoleId:"reviewer"}],getOpenApplication:async()=>events.includes("mark")?(events.push("reload"),{...open,channelStatus:"deleted"}):open,getApplicationClass:async()=>cls,markApplicationDeleted:async()=>{events.push("mark");return undefined;}}; const replies:any[]=[]; const command:any={guildId:"guild",guild,channelId:"outside",user:{id:"reviewer"},member:{roles:{cache:new Map((input.roles??["reviewer"]).map((r:string)=>[r,{}]))}},inGuild:()=>true,inCachedGuild:()=>true,options:{getSubcommandGroup:()=>null,getSubcommand:()=>"delete",getString:()=>"application"},deferReply:async()=>undefined,editReply:async(p:any)=>{replies.push(p);return{};},reply:async()=>undefined}; return {events,repository,guild,command,replies}; }
function text(payload: any): string[] {
  if (typeof (payload as { content?: unknown })?.content === "string") return [(payload as { content: string }).content]; return payload.components[0].toJSON().components.filter((component: any) => component.type === 10).map((component: any) => component.content); }
function title(payload: any): string | undefined { return text(payload)[0]?.replace(/^# /, ""); }
