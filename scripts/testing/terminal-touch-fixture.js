'use strict';
// Dispatch browser TouchEvents through the real component, without CDP.
async function touchDrag(
  locator,
  { dx = 0, dy = 0, steps = 8, cancel = false, multi = false } = {},
) {
  return locator.evaluate(
    async (el, options) => {
      const box = el.getBoundingClientRect(),
        x = box.left + box.width / 2,
        y = box.top + box.height / 2;
      const touch = (atX, atY, id = 9) =>
        new Touch({ identifier: id, target: el, clientX: atX, clientY: atY });
      const fire = (type, touches) => {
        const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      };
      fire('touchstart', [touch(x, y)]);
      const prevented = [];
      for (let step = 1; step <= options.steps; step++) {
        const touches = [
          touch(x + (options.dx * step) / options.steps, y + (options.dy * step) / options.steps),
        ];
        if (options.multi) touches.push(touch(x + 30, y, 10));
        prevented.push(fire('touchmove', touches));
        if (options.cancel && step === 1) {
          fire('touchcancel', []);
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      fire('touchend', []);
      return prevented;
    },
    { dx, dy, steps, cancel, multi },
  );
}
module.exports = { touchDrag };
