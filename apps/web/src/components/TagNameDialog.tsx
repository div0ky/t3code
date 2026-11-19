import { T } from "gt-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Request = {
  readonly title: string;
  readonly name: string;
  readonly resolve: (name: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a tag's name. Resolves null when dismissed or left blank. */
export function requestTagName(input: { title: string; name?: string }): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({ request: { title: input.title, name: input.name ?? "", resolve } }),
  );
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function TagNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending tag name request with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <TagNameDialog key={request.title + request.name} request={request} /> : null;
}

function TagNameDialog({ request }: { request: Request }) {
  const id = useId();
  const [name, setName] = useState(request.name);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0) finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>
                <T>Name</T>
              </Label>
              <Input
                id={`${id}-name`}
                autoFocus
                value={name}
                maxLength={48}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              <T>Save</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
