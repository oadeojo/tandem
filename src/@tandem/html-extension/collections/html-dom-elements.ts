import { DOMElements } from "./dom-elements";
import { SyntheticHTMLElement, SyntheticCSSStyleDeclaration, DOMNodeType } from "@tandem/synthetic-browser";

export class HTMLDOMElements extends DOMElements<SyntheticHTMLElement> {

  get style(): SyntheticCSSStyleDeclaration {
    const allStyle = {};
    for (const item of <SyntheticHTMLElement[]><any>this) {
      const itemStyle =  item.style;
      for (const name of itemStyle) {
        if (allStyle[name]) {
          allStyle[name] = "multiple values";
        } else {
          allStyle[name] = itemStyle[name];
        }
      }
    }
    return SyntheticCSSStyleDeclaration.fromObject(allStyle);
  }

  static fromArray(items: any): HTMLDOMElements {
    return new HTMLDOMElements(...items.filter((item) => {
      return item.nodeType === DOMNodeType.ELEMENT &&  !!(<SyntheticHTMLElement>item.style);
    }))
  }
}