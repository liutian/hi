import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';

import { StoreService } from 'app/core/store.service';

@Component({
  selector: 'app-welcome',
  templateUrl: './welcome.component.html',
  styleUrls: ['./welcome.component.scss']
})
export class WelcomeComponent implements OnInit {
  loginFormData = {
    loginName: ''
  };

  constructor(
    private router: Router,
    private storeService: StoreService) { }

  ngOnInit() {
  }

  login() {
    this.storeService.set('userInfo', this.loginFormData);
    this.router.navigateByUrl('talk');
  }

}
