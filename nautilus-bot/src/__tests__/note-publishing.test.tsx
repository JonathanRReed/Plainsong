import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotePublishSettingsSection } from "@/components/meetings/note-publish-settings";
import { NotePublishStatusLine } from "@/components/meetings/note-publish-status";

const api = vi.hoisted(() => ({get:vi.fn(),save:vi.fn(),pick:vi.fn(),status:vi.fn(),retry:vi.fn()}));
vi.mock("@/lib/backend/publishing",()=>({getNotePublishSettings:api.get,selectNotePublishLocation:api.pick,saveNotePublishConfig:api.save,getNotePublishStatus:api.status,retryNotePublish:api.retry}));
beforeEach(()=>{
  vi.resetAllMocks();
  api.get.mockResolvedValue({config:{enabled:false,locationId:null,templateId:"meeting",includeTranscript:false},location:null});
  api.save.mockImplementation(async config => ({config,location:config.locationId ? {id:config.locationId,label:"My notes",approved:true} : null}));
  api.status.mockResolvedValue({state:"none",error:null});
  api.retry.mockResolvedValue(undefined);
});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("starts off, requires the native folder approval, and saves format and transcript choices",async()=>{
  api.pick.mockResolvedValue({id:"opaque-id",label:"My notes",approved:true});
  render(<NotePublishSettingsSection/>);
  const enabled=await screen.findByRole("switch",{name:"Save notes to a folder"});
  await screen.findByRole("combobox",{name:"Notes format"});
  expect(enabled).toHaveAccessibleDescription(/Saves newly finished notes/);
  expect(screen.getByRole("combobox",{name:"Notes format"})).toHaveAccessibleDescription(/sync service may upload/);
  expect(enabled).not.toBeChecked();expect(enabled).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Choose notes folder"}));
  await screen.findByText("My notes");
  expect(api.pick).toHaveBeenCalledTimes(1);
  expect(api.save).toHaveBeenLastCalledWith({enabled:false,locationId:"opaque-id",templateId:"meeting",includeTranscript:false});
  fireEvent.click(enabled);
  await waitFor(()=>expect(enabled).toBeChecked());
  fireEvent.change(screen.getByRole("combobox",{name:"Notes format"}),{target:{value:"journal"}});
  await waitFor(()=>expect(api.save).toHaveBeenLastCalledWith({enabled:true,locationId:"opaque-id",templateId:"journal",includeTranscript:false}));
  await waitFor(()=>expect(screen.getByRole("checkbox",{name:"Include transcript"})).toBeEnabled());
  fireEvent.click(screen.getByRole("checkbox",{name:"Include transcript"}));
  await waitFor(()=>expect(api.save).toHaveBeenLastCalledWith({enabled:true,locationId:"opaque-id",templateId:"journal",includeTranscript:true}));
});
it("cancelling the picker does not enable or change publishing",async()=>{
  api.pick.mockResolvedValue(null);render(<NotePublishSettingsSection/>);
  await screen.findByRole("combobox");
  fireEvent.click(screen.getByRole("button",{name:"Choose notes folder"}));
  await waitFor(()=>expect(api.pick).toHaveBeenCalled());
  expect(api.save).not.toHaveBeenCalled();
});
it("reports a save failure without pretending the preference changed",async()=>{
  api.get.mockResolvedValue({config:{enabled:false,locationId:"id",templateId:"meeting",includeTranscript:false},location:{id:"id",label:"Notes",approved:true}});
  api.save.mockRejectedValue(new Error("Folder unavailable"));
  render(<NotePublishSettingsSection/>);
  await screen.findByText("Notes");
  fireEvent.click(screen.getByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Folder unavailable");
  expect(screen.getByRole("switch")).not.toBeChecked();
});
it("shows saved status, failure and Retry for the current meeting",async()=>{
  api.status.mockResolvedValueOnce({state:"saved",error:null}).mockResolvedValue({state:"error",error:"Folder unavailable"});
  const view=render(<NotePublishStatusLine recordingId="one"/>);
  expect(await screen.findByRole("status")).toHaveTextContent("Saved to folder");
  view.rerender(<NotePublishStatusLine recordingId="two"/>);
  expect(await screen.findByText("Couldn't save: Folder unavailable")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"Retry"}));
  await waitFor(()=>expect(api.retry).toHaveBeenCalledWith("two"));
  expect(await screen.findByText("Waiting to save to folder")).toBeInTheDocument();
});
it("ignores a status response from a previously selected meeting",async()=>{
  let resolveOld:(value:unknown)=>void=()=>{};
  api.status.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValue({state:"saved",error:null});
  const view=render(<NotePublishStatusLine recordingId="one"/>);
  view.rerender(<NotePublishStatusLine recordingId="two"/>);
  await screen.findByText("Saved to folder");
  await act(async()=>resolveOld({state:"error",error:"Wrong meeting"}));
  expect(screen.queryByText(/Wrong meeting/)).not.toBeInTheDocument();
});
it("can turn publishing off when its previous approval is no longer available",async()=>{
  api.get.mockResolvedValue({config:{enabled:true,locationId:"lost",templateId:"meeting",includeTranscript:false},location:{id:"lost",label:"Location needs reselection",approved:false}});
  render(<NotePublishSettingsSection/>);
  await screen.findByText("Location needs reselection");
  expect(screen.getByRole("switch")).toBeEnabled();
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(()=>expect(api.save).toHaveBeenCalledWith({enabled:false,locationId:"lost",templateId:"meeting",includeTranscript:false}));
});
