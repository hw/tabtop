export function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

export const join = (dir, name) => (dir ? `${dir}/${name}` : name);

