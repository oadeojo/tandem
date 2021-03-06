import { debounce, throttle, values } from "lodash";
import { decode } from "ent";
import { SEnvNodeTypes, SVG_XMLNS, HTML_XMLNS } from "../constants";
import { SEnvNodeInterface, documentMutators } from "../nodes";
import { 
  SEnvCSSStyleSheetInterface, 
  SEnvCSSObjectInterface, 
  SEnvCSSParentRuleInterface, 
  SEnvCSSRuleInterface,
  CSSParentObject,
  cssStyleSheetMutators,
  flattenSyntheticCSSStyleSheetSources
} from "../css";
import { SEnvWindowInterface, patchWindow, windowMutators, flattenWindowObjectSources } from "../window";
import { 
  SEnvParentNodeMutationTypes, 
  createParentNodeInsertChildMutation, 
  SEnvParentNodeInterface, 
  SEnvCommentInterface, 
  SEnvHTMLStyledElementInterface,
  filterNodes,
  SEnvElementInterface, 
  SEnvTextInterface, 
  createParentNodeRemoveChildMutation, 
  SEnvHTMLIFrameElementInterface 
} from "../nodes";
import { SEnvMutationEventInterface, getSEnvEventClasses } from "../events";
import { BaseSyntheticWindowRenderer, SyntheticWindowRendererNativeEvent } from "./base";
import { InsertChildMutation, RemoveChildMutation, MoveChildMutation, Mutation, Mutator, weakMemo, createZeroBounds } from "aerial-common2";
import { SET_SYNTHETIC_SOURCE_CHANGE, flattenNodeSources } from "../nodes";
import { getNodeByPath, getNodePath } from "../../utils";

const NODE_NAME_MAP = {
  style: "span",
  head: "span",
  html: "span",
  body: "span",
  link: "span",
  script: "span",
  iframe: "span"
};

const { SEnvWrapperEvent } = getSEnvEventClasses();

type CSSRuleDictionaryType = {
  [IDentifier: string]: [CSSGroupingRule|CSSRule|CSSStyleSheet, any]
}

type HTMLElementDictionaryType = {
  [IDentifier: string]: [Node, SEnvNodeInterface]
}

const RECOMPUTE_TIMEOUT = 1;

function getHostStylesheets(node: Node) {
  let p = node.parentNode;
  while(p.parentNode) p = p.parentNode;
  return (<Document>p).styleSheets || [];
}

// See https://github.com/crcn/tandem/blob/318095f9e8672935be4bffea6c7c72aa6d8b95cb/src/@tandem/synthetic-browser/renderers/dom/index.ts

// TODO - this should contain an iframe
export class SyntheticDOMRenderer extends BaseSyntheticWindowRenderer {
  readonly container: HTMLIFrameElement;
  readonly mount: HTMLDivElement;
  private _documentElement: HTMLElement;
  private _rendering: boolean;
  private _mutations: Mutation<any>[];
  private _elementDictionary: HTMLElementDictionaryType;
  private _cssRuleDictionary: CSSRuleDictionaryType;

  constructor(sourceWindow: SEnvWindowInterface, readonly targetDocument: Document) {
    super(sourceWindow);
    this.container = targetDocument.createElement("iframe");
    Object.assign(this.container.style, {
      border: "none",
      width: "100%",
      height: "100%"
    });

    this._onContainerResize = this._onContainerResize.bind(this);
    this.mount = targetDocument.createElement("div");
    this.mount.innerHTML = this.createMountInnerHTML();
    this.container.onload = () => {
      this.container.contentWindow.document.body.appendChild(this.mount);
      this.container.contentWindow.addEventListener("resize", this._onContainerResize);
      this.requestRender();
    };
  }

  createMountInnerHTML() {
    return "<span></span><div></div>";
  }

  protected async render() {
    if (!this._documentElement) {
      Array.prototype.forEach.call(this.sourceWindow.document.styleSheets, (styleSheet) => {
        this._registerStyleSheet(styleSheet);
      });

      this._documentElement = renderHTMLNode(this.sourceWindow.document, this._elementDictionary = {}, this.onElementChange, this.targetDocument);
      this.mount.lastChild.appendChild(this._documentElement);
    }

    this._resetComputedInfo();
  }

  private _remoteStylesheet(syntheticStyleSheet: SEnvCSSStyleSheetInterface) {
    const [nativeStyleSheet] = this.getCSSObjectDictItem(syntheticStyleSheet);

    if (nativeStyleSheet) {
      (nativeStyleSheet.ownerNode as Element).remove();
      this._cssRuleDictionary[syntheticStyleSheet.$id] = undefined;
    }
  }

  private _registerStyleSheet(syntheticStyleSheet: SEnvCSSStyleSheetInterface, index?: number) {
    if (this._cssRuleDictionary[syntheticStyleSheet.$id]) {
      return;
    }

    if (index == null) {
      index = Array.prototype.indexOf.call(this.sourceWindow.document.styleSheets, syntheticStyleSheet);
    }
    
    const styleElement = this.targetDocument.createElement("style") as HTMLStyleElement;
    styleElement.type = "text/css";
    styleElement.appendChild(document.createTextNode(syntheticStyleSheet.previewCSSText));
    const styleContainer = this.mount.firstChild;

    if (index >= styleContainer.childNodes.length) {
      styleContainer.appendChild(styleElement);
    } else {
      styleContainer.insertBefore(styleElement, styleContainer.childNodes[index]);
    }

    this._cssRuleDictionary[syntheticStyleSheet.$id] = [styleElement.sheet as CSSStyleSheet, syntheticStyleSheet];
  }

  private onElementChange = () => {
    this.requestRender();
  }

  private _updateCSSRules(staleStyleSheet: CSSStyleSheet, syntheticStyleSheet: SEnvCSSStyleSheetInterface) {
    while (staleStyleSheet.rules.length) {
      staleStyleSheet.deleteRule(0);
    }

    for (let i = 0, n = syntheticStyleSheet.cssRules.length; i < n; i++) {
      const rule = syntheticStyleSheet.cssRules[i] as SEnvCSSRuleInterface;
      try {
        staleStyleSheet.insertRule(rule.previewCSSText, staleStyleSheet.cssRules.length);
      } catch(e) {
        // browser may throw errors if it cannot parse the rule -- this will
        // happen unsupported vendor prefixes.
      }
    }
  }

  private _getSourceCSSText() {
    return Array.prototype.map.call(this.sourceWindow.document.stylesheets, (ss: SEnvCSSStyleSheetInterface) => (
      ss.previewCSSText
    )).join("\n");
  }

  protected _onContainerResize(event) {
    this._resetComputedInfo();
  }

  protected _onWindowMutation(event: SEnvMutationEventInterface) {
    super._onWindowMutation(event);

    const { mutation } = event;


    if (documentMutators[mutation.$type]) {
      const [nativeNode, syntheticObject] = this.getElementDictItem(mutation.target);
      
      if (nativeNode) {

        if (mutation.$type === SEnvParentNodeMutationTypes.REMOVE_CHILD_NODE_EDIT) {
          const removeMutation = mutation as RemoveChildMutation<any, SEnvNodeInterface>;

          const nestedChildren = flattenNodeSources(removeMutation.child.struct);

          for (const $id in nestedChildren) {
            const child = nestedChildren[$id];
            if (child.sheet) {
              this._remoteStylesheet(child.sheet);
            }
            this._elementDictionary[$id] = undefined;
          }

          (windowMutators[mutation.$type] as Mutator<any, any>)(nativeNode, mutation);
        } else if (mutation.$type === SEnvParentNodeMutationTypes.INSERT_CHILD_NODE_EDIT) {
          const insertMutation = mutation as RemoveChildMutation<any, SEnvNodeInterface>;
          const child = renderHTMLNode(insertMutation.child, this._elementDictionary, this.onElementChange, this.targetDocument);


          const styleElements = filterNodes(insertMutation.child, child => Boolean((child as any as HTMLStyleElement).sheet)) as any as SEnvHTMLStyledElementInterface[];
          styleElements.forEach((styleElement) => {
            this._registerStyleSheet(styleElement.sheet);
          });

          (windowMutators[mutation.$type] as Mutator<any, any>)(nativeNode, createParentNodeInsertChildMutation(nativeNode, child, insertMutation.index, false));
        } else {
          (windowMutators[mutation.$type] as Mutator<any, any>)(nativeNode, mutation);
        }
      } else {
        
        // MUST replace the entire CSS text here since vendor prefixes get stripped out
        // depending on the browser. This is the simplest method for syncing changes.
        const parentStyleSheet = (((mutation.target as CSSStyleDeclaration).parentRule && (mutation.target as CSSStyleDeclaration).parentRule.parentStyleSheet) || (mutation.target as CSSStyleRule).parentStyleSheet) as SEnvCSSStyleSheetInterface;
        if (parentStyleSheet) {
          const [nativeStyleSheet, syntheticStyleSheet] = this.getCSSObjectDictItem(parentStyleSheet);
          this._updateCSSRules(nativeStyleSheet as CSSStyleSheet, syntheticStyleSheet);
        }
      }
    }
  }

  protected getElementDictItem<T extends Node, U extends SEnvNodeInterface>(synthetic: SEnvNodeInterface): [T, U] {
    return this._elementDictionary && this._elementDictionary[synthetic.$id] || [undefined, undefined] as any;
  }

  protected getCSSObjectDictItem<T extends any, U extends any>(synthetic: any): [T, U] {
    return this._cssRuleDictionary && this._cssRuleDictionary[synthetic.$id] || [undefined, undefined] as any;
  }

  protected _deferResetComputedInfo = throttle(() => {
    this._resetComputedInfo();
  }, 10);

  protected _onWindowScroll(event: Event) {
    super._onWindowScroll(event);

    // TODO - possibly move this to render
    this.container.contentWindow.scroll(this._sourceWindow.scrollX, this._sourceWindow.scrollY);
  }

  private _resetComputedInfo() {
    const rects  = {};
    const styles = {};

    const targetWindow = this.targetDocument.defaultView;
    const containerWindow = this.container.contentWindow;
    const containerBody = containerWindow && containerWindow.document.body;

    if (!containerBody) {
      return;
    }

    for (let $id in this._elementDictionary) {
      const [native, synthetic] = this._elementDictionary[$id] || [undefined, undefined];

      if (synthetic && synthetic.nodeType === SEnvNodeTypes.ELEMENT) {

        const rect = (native as Element).getBoundingClientRect() || { width: 0, height: 0, left: 0, top: 0 };
        
        if (rect.width || rect.height || rect.left || rect.top) {
          rects[$id] = rect;
        }

        // just attach whatever's returned by the DOM -- don't wrap this in a synthetic, or else
        // there'll be massive performance penalties.
        styles[$id] = targetWindow.getComputedStyle(native as Element);
      }
    }

    if (containerBody) {
      this.setPaintedInfo(rects, styles, {
        width: containerBody.scrollWidth,
        height: containerBody.scrollHeight
      }, {
        left: containerWindow.scrollX,
        top: containerWindow.scrollY
      });
    }
  }

  protected reset() {
    this._documentElement = undefined;
    this._cssRuleDictionary = {};
    this._elementDictionary = {};
    const { mount } = this;

    if (mount) {
      mount.innerHTML = this.createMountInnerHTML();
      mount.onclick = 
      mount.ondblclick = 
      mount.onsubmit = 
      mount.onmousedown =
      mount.onmouseenter = 
      mount.onmouseleave = 
      mount.onmousemove  = 
      mount.onmouseout = 
      mount.onmouseover = 
      mount.onmouseup =
      mount.onmousewheel = 
      mount.onkeydown = 
      mount.onkeypress = 
      mount.onkeyup = (event: any) => {
        for (let $id in this._elementDictionary) {
          const [native, synthetic] = this._elementDictionary[$id] || [undefined, undefined];
          if (native === event.target) {
            this.onDOMEvent(synthetic as SEnvElementInterface, event);
          }
        }
      }
    }
  }
  
  private onDOMEvent (element: SEnvElementInterface, event: any) {

    // need to cast as synthetic event. This is fine for now though.
    const e = new SEnvWrapperEvent();
    e.init(event);
    element.dispatchEvent(e);
    event.stopPropagation();
    if (/submit/.test(event.type)) {
      event.preventDefault();
    }

    const ne = new SyntheticWindowRendererNativeEvent();
    ne.init(SyntheticWindowRendererNativeEvent.NATIVE_EVENT, element.$id, e);

    if (element.tagName.toLowerCase() === "input") {
      (element as any as HTMLInputElement).value = event.target.value;
    }

    this.dispatchEvent(ne);
  }
}

const eachMatchingElement = (a: SEnvNodeInterface, b: Node, each: (a: SEnvNodeInterface, b: Node) => any) => {
  each(a, b);
  Array.prototype.forEach.call(a.childNodes, (ac, i) => {
    eachMatchingElement(ac, b.childNodes[i], each);
  });
};

const renderHTMLNode = (node: SEnvNodeInterface, dict: HTMLElementDictionaryType, onChange: () => any, document: Document): any =>  {
  switch(node.nodeType) {

    case SEnvNodeTypes.TEXT:
      const value = node.textContent;
      const textNode = document.createTextNode(/^[\s\r\n\t]+$/.test(value) ? "" : value);
      dict[node.$id] = [textNode, node];
      return textNode;

    case SEnvNodeTypes.COMMENT:
      const comment = document.createComment((<SEnvCommentInterface>node).nodeValue);
      dict[node.$id] = [comment, node];
      return comment;

    case SEnvNodeTypes.ELEMENT:
      const syntheticElement = <SEnvElementInterface>node;

      const tagNameLower = syntheticElement.tagName.toLowerCase();
      const element = renderHTMLElement(tagNameLower, syntheticElement, dict, onChange, document);

      element.onload = onChange;
      for (let i = 0, n = syntheticElement.attributes.length; i < n; i++) {
        const syntheticAttribute = syntheticElement.attributes[i];
        if (syntheticAttribute.name === "class") {
          element.className = syntheticAttribute.value;
        } else {

          // some cases where the attribute name may be invalid - especially as the app is updating
          // as the user is typing. E.g: <i </body> will be parsed, but will thrown an error since "<" will be
          // defined as an attribute of <i>
          try {
            // get preview attribute value instead here
            let value = syntheticElement.getPreviewAttribute(syntheticAttribute.name);

            element.setAttribute(syntheticAttribute.name, value);
          } catch(e) {
            console.warn(e.stack);
          }
        }
      }

      if (tagNameLower === "iframe") {
        const iframe = syntheticElement as any as SEnvHTMLIFrameElementInterface;
        element.appendChild(iframe.contentWindow.renderer.container);
      }

      // add a placeholder for these blacklisted elements so that diffing & patching work properly
      if(/^(style|link|script|head)$/.test(tagNameLower)) {
        element.style.display = "none";
        return element;
      }

      return appendChildNodes(element, syntheticElement.childNodes, dict, onChange, document);
    case SEnvNodeTypes.DOCUMENT:
    case SEnvNodeTypes.DOCUMENT_FRAGMENT:
      const syntheticContainer = <SEnvParentNodeInterface>node;
      const containerElement = renderHTMLElement("span", syntheticContainer as SEnvElementInterface, dict, onChange, document);
      return appendChildNodes(containerElement, syntheticContainer.childNodes as any as SEnvNodeInterface[], dict, onChange, document);
  }
}

const renderHTMLElement = (tagName: string, source: SEnvElementInterface, dict: HTMLElementDictionaryType, onChange: () => any, document: Document): HTMLElement =>  {
  const mappedTagName = NODE_NAME_MAP[tagName.toLowerCase()] || tagName;
  const element = document.createElementNS(source.namespaceURI === SVG_XMLNS ? SVG_XMLNS : HTML_XMLNS, mappedTagName.toLowerCase()) as HTMLElement;

  if (source.shadowRoot) {
    appendChildNodes(element.attachShadow({ mode: "open" }), source.shadowRoot.childNodes as any as SEnvNodeInterface[], dict, onChange, document);
  }
  dict[source.$id] = [element, source];
  return element as any;
}

const appendChildNodes = (container: HTMLElement|DocumentFragment, syntheticChildNodes: SEnvNodeInterface[], dict: HTMLElementDictionaryType, onChange: () => any, document: Document) => {
  for (let i = 0, n = syntheticChildNodes.length; i < n; i++) {
    const childNode = renderHTMLNode(syntheticChildNodes[i], dict, onChange, document);

    // ignored
    if (childNode == null) continue;
    container.appendChild(childNode);
  }
  return container;
}

export const createSyntheticDOMRendererFactory = (targetDocument: Document) => (window: SEnvWindowInterface) => new SyntheticDOMRenderer(window, targetDocument);
