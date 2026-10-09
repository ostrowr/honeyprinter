export const PAGE_HEIGHT = 3.7;
const MAX_PAGES = 8;

// Keep the visible strip in place when inserting an older receipt. A selection
// moves the print head along that strip without adding copies.
export class PaperRoll<T extends {id: number}> {
  readonly pages: T[] = [];
  selected = -1;
  position = PAGE_HEIGHT;
  target = PAGE_HEIGHT;

  select(receipt: T, direction = 1, animate = true) {
    let index = -1;
    if (this.pages[this.selected]?.id === receipt.id) index = this.selected;
    else if (direction < 0) {
      for (let i = this.selected - 1; i >= 0; i--) if (this.pages[i].id === receipt.id) { index = i; break; }
    } else {
      for (let i = this.selected + 1; i < this.pages.length; i++) if (this.pages[i].id === receipt.id) { index = i; break; }
    }
    if (index < 0) {
      index = direction < 0 ? Math.max(0, this.selected) : this.selected + 1;
      this.insert(receipt, index);
    } else this.pages[index] = receipt;
    this.selected = index;
    this.target = (index + 1) * PAGE_HEIGHT;
    this.trim();
    if (!animate) this.settle();
  }

  insert(receipt: T, index: number) {
    if (!this.pages.length) this.position = 0;
    else if (index <= this.selected || this.position > index * PAGE_HEIGHT + 1e-6) this.position += PAGE_HEIGHT;
    this.pages.splice(index, 0, receipt);
  }

  trim() {
    // The canvas texture stays bounded while navigating arbitrarily long history.
    const excess = this.pages.length - MAX_PAGES;
    if (excess <= 0) return;
    const before = Math.min(excess, this.selected);
    this.pages.splice(0, before);
    this.pages.splice(MAX_PAGES);
    this.selected -= before;
    this.position = Math.max(0, Math.min(this.pages.length * PAGE_HEIGHT, this.position - before * PAGE_HEIGHT));
    this.target -= before * PAGE_HEIGHT;
  }

  get direction() {
    return Math.abs(this.target - this.position) < 1e-6 ? 0 : Math.sign(this.target - this.position);
  }

  advance(distance: number) {
    this.position += this.direction * Math.min(Math.abs(this.target - this.position), distance);
  }

  settle() { this.position = this.target; }
}
