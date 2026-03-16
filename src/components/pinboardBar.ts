import '@girs/gnome-shell/dist/extensions/global';

import Clutter from '@girs/clutter-17';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import type { ExtensionBase } from '@girs/gnome-shell/dist/extensions/sharedInternals';
import GObject from '@girs/gobject-2.0';
import St from '@girs/st-17';
import { scrollViewAddChild } from '@pano/utils/compatibility';
import { db, PinboardDefinition } from '@pano/utils/db';
import { registerGObjectClass, SignalRepresentationType, SignalsDefinition } from '@pano/utils/gjs';
import { getCurrentExtensionSettings, gettext } from '@pano/utils/shell';
import { orientationCompatibility } from '@pano/utils/shell_compatibility';

export type PinboardBarSignalType = 'pinboard-selected' | 'pinboard-changed';

interface PinboardBarSignals extends SignalsDefinition<PinboardBarSignalType> {
  'pinboard-selected': SignalRepresentationType<[GObject.GType<string>]>;
  'pinboard-changed': Record<string, never>;
}

// Preset colors assigned in round-robin to new boards
const PINBOARD_COLORS = [
  'rgb(98, 160, 234)',
  'rgb(255, 120, 80)',
  'rgb(51, 209, 122)',
  'rgb(237, 51, 59)',
  'rgb(192, 97, 203)',
  'rgb(255, 193, 7)',
];

@registerGObjectClass
export class PinboardBar extends St.BoxLayout {
  static metaInfo: GObject.MetaInfo<Record<string, never>, Record<string, never>, PinboardBarSignals> = {
    GTypeName: 'PinboardBar',
    Signals: {
      'pinboard-selected': {
        param_types: [GObject.TYPE_STRING],
        accumulator: 0,
      },
      'pinboard-changed': {},
    },
  };

  private settings: Gio.Settings;
  private ext: ExtensionBase;
  private activePinboardId: string = ''; // '' = "Clipboard History" (show all)
  private buttonContainer: St.BoxLayout;
  private settingsChangedId: number | null = null;

  constructor(ext: ExtensionBase) {
    super({
      styleClass: 'pano-pinboard-bar',
      xExpand: true,
      ...orientationCompatibility(false),
    });

    this.ext = ext;
    this.settings = getCurrentExtensionSettings(ext);

    this.buttonContainer = new St.BoxLayout({
      styleClass: 'pano-pinboard-button-container',
      ...orientationCompatibility(false),
    });

    const scrollView = new St.ScrollView({
      xExpand: true,
      overlayScrollbars: true,
    });
    scrollView.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);
    scrollViewAddChild(scrollView, this.buttonContainer);
    this.add_child(scrollView);

    this.rebuildButtons();

    this.settingsChangedId = this.settings.connect('changed::pinboards', () => this.rebuildButtons());
  }

  private getPinboards(): PinboardDefinition[] {
    try {
      return JSON.parse(this.settings.get_string('pinboards')) as PinboardDefinition[];
    } catch {
      return [];
    }
  }

  private savePinboards(boards: PinboardDefinition[]): void {
    this.settings.set_string('pinboards', JSON.stringify(boards));
  }

  private rebuildButtons(): void {
    this.buttonContainer.remove_all_children();

    // Default "Clipboard History" pill
    this.buttonContainer.add_child(this.createPill('', this.gettext('Clipboard History'), ''));

    // Custom board pills
    for (const board of this.getPinboards()) {
      this.buttonContainer.add_child(this.createPill(board.id, board.name, board.color));
    }

    // "+" create button
    const addButton = new St.Button({
      styleClass: 'pano-pinboard-add-button',
      label: '+',
      xExpand: false,
      reactive: true,
    });
    addButton.connect('clicked', () => {
      this.showInlineCreateEntry();
      return Clutter.EVENT_PROPAGATE;
    });
    this.buttonContainer.add_child(addButton);
  }

  private createPill(id: string, name: string, color: string): St.Button {
    const isActive = id === this.activePinboardId;

    const pill = new St.Button({
      styleClass: `pano-pinboard-pill${isActive ? ' active' : ''}`,
      xExpand: false,
      reactive: true,
    });

    const label = new St.Label({
      text: name,
      yAlign: Clutter.ActorAlign.CENTER,
    });

    if (id !== '' && color) {
      // Colored dot before label
      const dot = new St.Label({
        text: '● ',
        yAlign: Clutter.ActorAlign.CENTER,
        styleClass: 'pano-pinboard-dot',
      });
      dot.set_style(`color: ${color};`);

      const box = new St.BoxLayout({ ...orientationCompatibility(false) });
      box.add_child(dot);
      box.add_child(label);
      pill.set_child(box);
    } else {
      pill.set_child(label);
    }

    pill.connect('clicked', () => {
      this.activePinboardId = id;
      this.rebuildButtons();
      this.emit('pinboard-selected', id);
      return Clutter.EVENT_PROPAGATE;
    });

    // Right-click on custom boards: show delete option
    if (id !== '') {
      pill.connect('button-press-event', (_: St.Button, event: Clutter.Event) => {
        if (event.get_button() === 3) {
          this.showDeleteConfirm(id, name, pill);
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });
    }

    return pill;
  }

  private showDeleteConfirm(pinboardId: string, name: string, anchor: St.Button): void {
    // Show a small inline popup next to the pill with Delete/Cancel
    const popup = new St.BoxLayout({
      styleClass: 'pano-pinboard-popup',
      ...orientationCompatibility(false),
      reactive: true,
    });

    const deleteBtn = new St.Button({
      styleClass: 'pano-pinboard-popup-delete',
      label: `${this.gettext('Delete')} "${name}"`,
      reactive: true,
    });
    const cancelBtn = new St.Button({
      styleClass: 'pano-pinboard-popup-cancel',
      label: this.gettext('Cancel'),
      reactive: true,
    });

    deleteBtn.connect('clicked', () => {
      this.deletePinboard(pinboardId);
      popup.destroy();
      return Clutter.EVENT_PROPAGATE;
    });
    cancelBtn.connect('clicked', () => {
      popup.destroy();
      return Clutter.EVENT_PROPAGATE;
    });

    popup.add_child(deleteBtn);
    popup.add_child(cancelBtn);

    // Insert popup after the anchor pill
    const parent = anchor.get_parent();
    if (parent) {
      const idx = parent.get_children().indexOf(anchor);
      parent.insert_child_at_index(popup, idx + 1);
    }
  }

  private showInlineCreateEntry(): void {
    // Remove the "+" button and show an inline entry
    const lastChild = this.buttonContainer.get_last_child();
    if (lastChild) {
      this.buttonContainer.remove_child(lastChild);
    }

    const entry = new St.Entry({
      styleClass: 'pano-pinboard-new-entry',
      hintText: this.gettext('Board name…'),
      canFocus: true,
      width: 120,
    });

    const confirmBtn = new St.Button({
      styleClass: 'pano-pinboard-add-button',
      label: '✓',
      reactive: true,
    });
    const cancelBtn = new St.Button({
      styleClass: 'pano-pinboard-add-button',
      label: '✕',
      reactive: true,
    });

    const doCreate = () => {
      const name = entry.get_text()?.trim();
      if (name && name.length > 0) {
        const boards = this.getPinboards();
        const newBoard: PinboardDefinition = {
          id: GLib.uuid_string_random(),
          name,
          color: PINBOARD_COLORS[boards.length % PINBOARD_COLORS.length]!,
        };
        boards.push(newBoard);
        this.savePinboards(boards);
        this.emit('pinboard-changed');
      } else {
        this.rebuildButtons();
      }
    };

    confirmBtn.connect('clicked', () => {
      doCreate();
      return Clutter.EVENT_PROPAGATE;
    });
    cancelBtn.connect('clicked', () => {
      this.rebuildButtons();
      return Clutter.EVENT_PROPAGATE;
    });
    entry.clutterText.connect('activate', doCreate);

    this.buttonContainer.add_child(entry);
    this.buttonContainer.add_child(confirmBtn);
    this.buttonContainer.add_child(cancelBtn);
    entry.grab_key_focus();
  }

  deletePinboard(pinboardId: string): void {
    const boards = this.getPinboards().filter((b) => b.id !== pinboardId);
    db.deletePinboard(pinboardId);
    this.savePinboards(boards);
    if (this.activePinboardId === pinboardId) {
      this.activePinboardId = '';
      this.emit('pinboard-selected', '');
    }
    this.emit('pinboard-changed');
  }

  showAssignDialog(clipboardId: number): void {
    const boards = this.getPinboards();
    if (boards.length === 0) {
      this.showInlineCreateEntry();
      return;
    }

    const currentBoardIds = db.queryPinboardsForItem(clipboardId);

    // Build a floating overlay anchored at the top of this bar
    const overlay = new St.BoxLayout({
      styleClass: 'pano-assign-dialog',
      ...orientationCompatibility(true),
      reactive: true,
    });

    const titleLabel = new St.Label({
      text: this.gettext('Add to Pinboard'),
      styleClass: 'pano-assign-dialog-title',
    });
    overlay.add_child(titleLabel);

    for (const board of boards) {
      const isAssigned = currentBoardIds.includes(board.id);
      const rowBtn = new St.Button({
        styleClass: `pano-assign-dialog-row${isAssigned ? ' assigned' : ''}`,
        reactive: true,
        xExpand: true,
      });

      const rowBox = new St.BoxLayout({ ...orientationCompatibility(false) });
      const dot = new St.Label({ text: '● ', styleClass: 'pano-pinboard-dot' });
      dot.set_style(`color: ${board.color};`);
      const nameLabel = new St.Label({ text: board.name, xExpand: true });
      const checkLabel = new St.Label({ text: isAssigned ? '✓' : '' });

      rowBox.add_child(dot);
      rowBox.add_child(nameLabel);
      rowBox.add_child(checkLabel);
      rowBtn.set_child(rowBox);

      rowBtn.connect('clicked', () => {
        if (isAssigned) {
          db.removeItemFromPinboard(board.id, clipboardId);
        } else {
          db.addItemToPinboard(board.id, clipboardId);
        }
        overlay.destroy();
        this.emit('pinboard-changed');
        return Clutter.EVENT_PROPAGATE;
      });

      overlay.add_child(rowBtn);
    }

    const closeBtn = new St.Button({
      styleClass: 'pano-pinboard-add-button',
      label: this.gettext('Close'),
      xExpand: true,
      reactive: true,
    });
    closeBtn.connect('clicked', () => {
      overlay.destroy();
      return Clutter.EVENT_PROPAGATE;
    });
    overlay.add_child(closeBtn);

    // Add overlay as sibling in the pano-window
    const panoWindow = this.get_parent();
    if (panoWindow) {
      panoWindow.add_child(overlay);
    }
  }

  getActivePinboardId(): string {
    return this.activePinboardId;
  }

  private gettext(str: string): string {
    return gettext(this.ext)(str);
  }

  override destroy(): void {
    if (this.settingsChangedId) {
      this.settings.disconnect(this.settingsChangedId);
      this.settingsChangedId = null;
    }
    super.destroy();
  }
}
