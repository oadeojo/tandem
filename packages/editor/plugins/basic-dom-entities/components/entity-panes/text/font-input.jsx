

import React from 'react';
import createStyleReference from './create-style-reference';
import SearchDropdownComponent from 'common/components/inputs/searchable-dropdown';

class FontInputComponent extends React.Component {
  render() {

    function createLabel(item, i) {
      var style = {
        fontFamily: item.value
      };
      return <span style={style}>{ item.label }</span>;
    }

    var entity = this.props.entity;

    // TODO - this should be a plugin instead
    // Just get this to work for now
    var fonts = (this.props.fonts || []).sort(function(a, b) {
      return a.label > b.label ? -1 : 1;
    });

    return <SearchDropdownComponent className='m-font-input' defaultLabel={'Select Font'} labelProperty={createLabel} items={fonts} reference={createStyleReference(entity, 'fontFamily')}>
    </SearchDropdownComponent>;
  }
}

export default FontInputComponent;
